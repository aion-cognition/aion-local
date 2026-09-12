import {
  describeError,
  describePairing,
  GraphConnection,
  loadConfig,
  Neo4jPairingError,
  parseEnvFile,
  seedEnvFromTemplate,
  SqliteStore,
  verifyNeo4jPairing,
  waitForBoltReady,
  type Config,
} from '@aion/core';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { waitForMcpHealth } from './compose.js';
import { buildDoctorChecks, runChecks, summarize } from './doctor.js';
import { HOST_ACTIONS, NativeSetupError, type HostActions } from './host-actions.js';
import { applyNativeEnv, envFileEntry, planNativeEnv } from './install-profile.js';
import {
  launchAgentPath,
  launchdCommands,
  MCP_LAUNCH_LABEL,
  mcpScriptPath,
  renderLaunchdPlist,
} from './launchd.js';
import {
  applyNeo4jSettings,
  ensureGdsPlugin,
  ensureNeo4jInstalled,
  NEO4J_SETTINGS,
  passwordRefusal,
  readInstalledServerVersion,
  resolveNeo4jLayout,
  setInitialPassword,
  startNeo4j,
} from './native-graph.js';
import type { Writer } from './output.js';
import { envFilePath, envTemplatePath } from './paths.js';

/**
 * The three steps the native profile does differently, and nothing else. Everything between them
 * — the member name, the schema, the migrations, the backbone, the birth event — is the same code
 * on both profiles, because it is the substrate rather than the machine.
 *
 * No step brings anything up. Init on the docker profile starts the two services compose owns;
 * here, both processes are owned by something else, so init verifies the one that is already
 * running and writes the job file for the one that is not.
 */

/**
 * Records the profile and its addresses, then re-reads config through them. Both halves are
 * needed: the file is what the service and every later command read, and this process is what
 * the rest of this run reads, since nothing on the host loads `.env` on its own.
 *
 * An address the install chose for itself is kept rather than converted, and said so out loud.
 * Re-running init must not take back an external Neo4j or a data directory somebody moved.
 */
export function prepareNativeProfile(write: Writer, repoDir: string): Config {
  const envPath = envFilePath(repoDir);
  const templatePath = envTemplatePath(repoDir);
  seedEnvFromTemplate(envPath, templatePath);
  const plan = planNativeEnv({
    home: homedir(),
    current: (key) => envFileEntry(envPath, key),
    template: (key) => envFileEntry(templatePath, key),
  });
  applyNativeEnv(envPath, plan, process.env);
  write(`native profile recorded in ${envPath}`);
  for (const step of plan) {
    const value = step.action === 'wrote' ? step.value : (envFileEntry(envPath, step.key) ?? '');
    write(`  ${step.action === 'wrote' ? 'set ' : 'kept'} ${step.key}=${value}`);
  }
  return loadConfig(process.env);
}

/**
 * A server this run just started is booting a JVM and loading a 67 MB plugin, which is the same
 * first-boot wait the docker profile allows for. One that is already up answers the single
 * `health()` probe above in well under a second and never reaches this.
 */
const FRESH_BOLT_TIMEOUT_MS = 180_000;

/** Bad credentials and no server at all arrive as the same shape, and want opposite answers. */
function looksLikeAuthFailure(error: string | undefined): boolean {
  const text = (error ?? '').toLowerCase();
  return text.includes('unauthorized') || text.includes('authentication');
}

async function readPairing(uri: string, password: string, write: Writer): Promise<void> {
  const connection = new GraphConnection({ uri, password });
  try {
    const pairing = await verifyNeo4jPairing(connection.driver, uri);
    write(`  ${describePairing(pairing)}`);
  } catch (err) {
    if (!(err instanceof Neo4jPairingError)) {
      throw err;
    }
    // The pairing error carries its own remedy, and the CLI's usage path prints a message. Fold
    // the steps into the message so the operator gets them rather than a one-line verdict.
    throw new NativeSetupError(err.message, err.remedy);
  } finally {
    await connection.close();
  }
}

/**
 * Brings up the graph a native install runs on, doing the work rather than describing it: install
 * the server if it is missing, put the matching verified plugin in place, write the substrate's
 * settings, set the password, start it, then check the pairing it came up with.
 *
 * A server that already answers is left exactly as it is. That is the idempotent path and the
 * common one: re-running init on a healthy install reads the pairing and changes nothing.
 */
export async function provisionNativeGraph(
  config: Config,
  password: string,
  write: Writer,
  actions: HostActions = HOST_ACTIONS,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const { uri } = config.neo4j;
  write(`neo4j at ${uri}`);
  const probe = await new GraphConnection({ uri, password }).health();
  if (probe.reachable) {
    write('  already running');
    await readPairing(uri, password, write);
    return;
  }
  if (looksLikeAuthFailure(probe.error)) {
    throw passwordRefusal(uri, await resolveNeo4jLayout(actions, env));
  }

  const layout = await ensureNeo4jInstalled(actions, env, write);
  const version = await readInstalledServerVersion(layout, actions);
  if (version === undefined) {
    throw new NativeSetupError(
      `could not read the Neo4j version under ${layout.home}, and the plugin to install is chosen by it:`,
      [`${layout.serverBin ?? join(layout.home, 'bin', 'neo4j')} --version`],
    );
  }
  write(`  neo4j ${version}`);
  await ensureGdsPlugin(layout, version, actions, write);
  const changed = applyNeo4jSettings(layout.confFile, NEO4J_SETTINGS);
  write(
    changed.length === 0
      ? `  ${layout.confFile} already carries every setting`
      : `  ${layout.confFile}: set ${changed.join(', ')}`,
  );
  await setInitialPassword(layout, password, actions);
  await startNeo4j(layout, actions, write);

  write(`  waiting for bolt (first start loads the plugin)`);
  try {
    await waitForBoltReady({ uri, password }, { timeoutMs: FRESH_BOLT_TIMEOUT_MS });
  } catch (err) {
    const failure = err instanceof Error ? err.message : String(err);
    if (looksLikeAuthFailure(failure)) {
      throw passwordRefusal(uri, layout);
    }
    throw new NativeSetupError(`neo4j did not answer on ${uri}: ${failure}`, [
      `tail -n 40 ${join(layout.home, 'logs', 'neo4j.log')}`,
      `${layout.serverBin ?? 'neo4j'} console   # run it in the foreground to see why`,
    ]);
  }
  await readPairing(uri, password, write);
}

/**
 * The `AION_*` environment the service would have got from compose's `env_file`. Read from the
 * file rather than from this process, so the job carries what the install recorded rather than
 * whatever shell started init. `AION_BUILD_SHA` is added when the wrapper computed one: it is
 * how `aion doctor` tells a service running older code from a fresh one, and on this profile
 * nothing bakes it into an image.
 */
export function serviceEnvironment(
  envPath: string,
  env: NodeJS.ProcessEnv,
): readonly (readonly [string, string])[] {
  const recorded = existsSync(envPath) ? [...parseEnvFile(readFileSync(envPath, 'utf8'))] : [];
  const pairs: readonly (readonly [string, string])[] = recorded.filter(
    ([key, value]) => key.startsWith('AION_') && value.trim() !== '',
  );
  const buildSha = (env.AION_BUILD_SHA ?? '').trim();
  return buildSha === '' ? pairs : [...pairs, ['AION_BUILD_SHA', buildSha] as const];
}

/**
 * Writes the launchd job, loads it, and waits for the server to answer — the same three steps
 * compose does for `aion-mcp` on the other profile, in the units a host process takes them.
 *
 * A job whose file has not changed and whose server is already answering is left alone: that is
 * the idempotent path, and bouncing a running service to arrive where it already is would make a
 * re-run of init more disruptive than doing nothing. Anything else is `bootout` then `bootstrap`,
 * because launchd reads the plist at load and a rewritten file reaches a loaded job no other way.
 *
 * A build is a prerequisite rather than something to attempt here. The server runs from
 * `packages/mcp/dist` on this profile, where the docker profile had the image build behind it.
 */
export type NativeServiceSeams = {
  readonly actions?: HostActions;
  /** The user's home, which is where launchd looks for agents. Tests point it somewhere else. */
  readonly home?: string;
  /** The readiness wait, so a test can answer for a server it did not start. */
  readonly waitFor?: typeof waitForMcpHealth;
};

export async function prepareNativeService(
  config: Config,
  repoDir: string,
  write: Writer,
  seams: NativeServiceSeams = {},
): Promise<void> {
  const actions = seams.actions ?? HOST_ACTIONS;
  const home = seams.home ?? homedir();
  const readiness = seams.waitFor ?? waitForMcpHealth;
  const script = mcpScriptPath(repoDir);
  if (!existsSync(script)) {
    throw new NativeSetupError(
      `the native profile runs the MCP server from ${script}, which is not built:`,
      ['npm ci && npm run build', 'aion init --profile native'],
    );
  }

  const logDir = dirname(config.logging.filePath);
  mkdirSync(logDir, { recursive: true });
  const port = config.operational.mcpPort;

  if (process.platform !== 'darwin') {
    write('no launchd on this platform; run the server yourself and keep it running:');
    write(`  ${process.execPath} ${script}`);
    write('  (a systemd user unit wants the same command, environment and 20s stop timeout)');
    return;
  }

  const plistPath = launchAgentPath(home);
  mkdirSync(dirname(plistPath), { recursive: true });
  const plist = renderLaunchdPlist({
    nodePath: process.execPath,
    repoDir,
    environment: serviceEnvironment(envFilePath(repoDir), process.env),
    standardErrorPath: `${logDir}/aion-mcp.launchd.err.log`,
  });
  const unchanged = existsSync(plistPath) && readFileSync(plistPath, 'utf8') === plist;
  if (unchanged && (await mcpAnswers(readiness, port))) {
    write(`aion-mcp already running under ${MCP_LAUNCH_LABEL}`);
    return;
  }
  writeFileSync(plistPath, plist);
  write(`launchd job ${plistPath}`);
  await loadLaunchdJob(plistPath, actions, write);

  write(`waiting for aion-mcp health on port ${String(port)}`);
  try {
    await readiness(port);
  } catch (err) {
    throw new NativeSetupError(
      `the launchd job is loaded and aion-mcp did not answer on port ${String(port)}: ${describeError(err)}`,
      [
        `tail -n 40 ${logDir}/aion-mcp.launchd.err.log`,
        `tail -n 40 ${config.logging.filePath}`,
        `launchctl print gui/${String(process.getuid?.() ?? 0)}/${MCP_LAUNCH_LABEL} | head -n 20`,
      ],
    );
  }
  write('  aion-mcp healthy');
}

/** Whether the server is already answering, which is what makes a re-run a no-op. */
async function mcpAnswers(readiness: typeof waitForMcpHealth, port: number): Promise<boolean> {
  try {
    // A short probe: this only asks whether the job is already serving, and the full wait is for
    // the load that follows.
    await readiness(port, { timeoutMs: 1_500, pollIntervalMs: 500 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Unload, then load. `bootout` on a job that is not there fails and that failure is the normal
 * case on a first install, so only the load is judged.
 */
async function loadLaunchdJob(
  plistPath: string,
  actions: HostActions,
  write: Writer,
): Promise<void> {
  const domain = `gui/${String(process.getuid?.() ?? 0)}`;
  await actions.run('launchctl', ['bootout', domain, plistPath]);
  const loaded = await actions.run('launchctl', ['bootstrap', domain, plistPath]);
  if (!loaded.ok) {
    throw new NativeSetupError(
      `launchctl could not load ${plistPath}: ${loaded.stderr.trim()}`,
      launchdCommands(plistPath),
    );
  }
  write(`  loaded ${MCP_LAUNCH_LABEL} in ${domain}`);
}

/**
 * The install's own verdict, from the surface that owns verdicts. Init has just changed a machine
 * in a dozen ways, and the honest close is the same report `aion doctor` would give rather than a
 * summary written here that could disagree with it.
 */
export async function reportNativeHealth(
  config: Config,
  password: string,
  write: Writer,
): Promise<void> {
  write('');
  write('doctor:');
  const store = new SqliteStore({ filePath: config.sqlite.path });
  const connection = new GraphConnection({ uri: config.neo4j.uri, password });
  try {
    summarize(
      await runChecks(buildDoctorChecks({ config, connection, db: store.db }), write),
      write,
    );
  } finally {
    await connection.close();
    store.close();
  }
}
