import {
  describeError,
  describePairing,
  GraphConnection,
  loadConfig,
  envFileValue,
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

import { readMcpHealth, waitForMcpHealth } from './compose.js';
import { buildDoctorChecks, runChecks, summarize } from './doctor.js';
import { HOST_ACTIONS, NativeSetupError, type HostActions } from './host-actions.js';
import { INSTALL_MANIFEST_VERSION, writeInstallManifest } from './install-manifest.js';
import { applyNativeEnv, planNativeEnv } from './install-profile.js';
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
import {
  isRealBuildSha,
  launchdDomain,
  readPortOwnership,
  UNSTAMPED_BUILD,
  verifyServiceBinding,
  type IntendedService,
  type ServiceBinding,
} from './service-binding.js';

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
 * Records host addresses in the file the service reads and in this setup process's config.
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
    current: (key) => envFileValue(envPath, key),
    template: (key) => envFileValue(templatePath, key),
  });
  applyNativeEnv(envPath, plan, process.env);
  write(`native profile recorded in ${envPath}`);
  for (const step of plan) {
    const value = step.action === 'wrote' ? step.value : (envFileValue(envPath, step.key) ?? '');
    write(`  ${step.action === 'wrote' ? 'set ' : 'kept'} ${step.key}=${value}`);
  }
  return loadConfig(process.env);
}

/**
 * A server this run just started is booting a JVM and loading a 67 MB plugin. A live run needed
 * most of five further minutes past the old 180s ceiling to finish that boot, which is what
 * widened this rather than a guess at a safer number. One that is already up answers the single
 * `health()` probe above in well under a second and never reaches this wait at all.
 */
const FRESH_BOLT_TIMEOUT_MS = 600_000;

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
export type NativeGraphRecord = {
  readonly neo4jHome: string;
  readonly neo4jConfFile: string;
  readonly gdsJar: string | undefined;
};

export async function provisionNativeGraph(
  config: Config,
  password: string,
  write: Writer,
  actions: HostActions = HOST_ACTIONS,
  env: NodeJS.ProcessEnv = process.env,
): Promise<NativeGraphRecord | undefined> {
  const { uri } = config.neo4j;
  write(`neo4j at ${uri}`);
  const probe = await GraphConnection.probe({ uri, password });
  if (probe.reachable) {
    write('  already running');
    await readPairing(uri, password, write);
    // Nothing of ours on this machine: a server that was already up is a server we did not set up.
    return undefined;
  }
  if (looksLikeAuthFailure(probe.error)) {
    throw passwordRefusal(uri, await resolveNeo4jLayout(actions, env), actions, env);
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
  const gdsJar = await ensureGdsPlugin(layout, version, actions, write);
  const changed = applyNeo4jSettings(layout.confFile, NEO4J_SETTINGS);
  write(
    changed.length === 0
      ? `  ${layout.confFile} already carries every setting`
      : `  ${layout.confFile}: set ${changed.join(', ')}`,
  );
  await setInitialPassword(layout, password, actions, env);
  await startNeo4j(layout, actions, write);

  write(`  waiting for bolt (first start loads the plugin)`);
  try {
    await waitForBoltReady({ uri, password }, { timeoutMs: FRESH_BOLT_TIMEOUT_MS });
  } catch (err) {
    const failure = err instanceof Error ? err.message : String(err);
    if (looksLikeAuthFailure(failure)) {
      throw passwordRefusal(uri, layout, actions, env);
    }
    throw new NativeSetupError(`neo4j did not answer on ${uri}: ${failure}`, [
      `tail -n 40 ${join(layout.home, 'logs', 'neo4j.log')}`,
      `${layout.serverBin ?? 'neo4j'} console   # run it in the foreground to see why`,
      'aion init --install native   # safe to re-run once bolt answers; a slow first boot is still starting, not broken',
    ]);
  }
  await readPairing(uri, password, write);
  return { neo4jHome: layout.home, neo4jConfFile: layout.confFile, gdsJar };
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
 * compose does for `aion-mcp` on the other profile.
 *
 * A service is left alone only when it is provably the intended one: the listener is our job's
 * process, running our build, holding the store at the configured path. Matching plist text and a
 * 200 on the port establish none of that — a process whose store file was deleted underneath it
 * keeps the handle, the port, and the answer. Ownership is read first on every branch, since a
 * refusal arriving after the plist is rewritten refuses nothing; an owned service failing any of
 * the three is `bootout` then `bootstrap`, and a listener that is not the job's is reported, never
 * stopped.
 *
 * A build is a prerequisite rather than something to attempt here: this profile runs from
 * `packages/mcp/dist`, where the docker profile had an image build behind it.
 */
export type NativeServiceSeams = {
  readonly actions?: HostActions;
  /** The user's home, which is where launchd looks for agents. Tests point it somewhere else. */
  readonly home?: string;
  /** The readiness wait, so a test can answer for a server it did not start. */
  readonly waitFor?: typeof waitForMcpHealth;
  /** The probe body, so a test can say what answered rather than only that something did. */
  readonly readHealth?: typeof readMcpHealth;
};

/** What the job this run would write says the service should be running. */
function intendedBuildSha(environment: readonly (readonly [string, string])[]): string {
  const stamped = environment.find(([key]) => key === 'AION_BUILD_SHA');
  if (stamped === undefined) {
    return UNSTAMPED_BUILD;
  }
  return stamped[1];
}

/** Where an operator looks when the service on the port is not the one this install owns. */
function bindingCommands(config: Config, logDir: string): readonly string[] {
  return [
    `lsof -nP -iTCP:${String(config.operational.mcpPort)} -sTCP:LISTEN`,
    `launchctl print ${launchdDomain()}/${MCP_LAUNCH_LABEL} | head -n 20`,
    `tail -n 40 ${logDir}/aion-mcp.launchd.err.log`,
  ];
}

/**
 * The refusal for a listener this install may not claim, wherever the check ran. `unverified` gets
 * the build steps: the process is the job's, and what is missing is a committed, stamped build to
 * match it against, which no restart would produce.
 */
function bindingRefusal(
  binding: Exclude<ServiceBinding, { kind: 'bound' }>,
  config: Config,
  logDir: string,
): NativeSetupError {
  const port = config.operational.mcpPort;
  if (binding.kind === 'unowned') {
    return new NativeSetupError(
      `port ${String(port)} is answering and the process serving it is not ${MCP_LAUNCH_LABEL}: ${binding.reason}.`,
      bindingCommands(config, logDir),
    );
  }
  if (binding.kind === 'unverified') {
    return new NativeSetupError(
      `port ${String(port)} is answering and this install cannot say what it is running: ${binding.reason}.`,
      ['npm run build', 'aion init --install native', ...bindingCommands(config, logDir)],
    );
  }
  return new NativeSetupError(
    `aion-mcp answered on port ${String(port)} and is not serving ${config.sqlite.path}: ${binding.reason}.`,
    bindingCommands(config, logDir),
  );
}

/**
 * Whether this run may write the job file and load it, read before anything on the host changes. A
 * listener that is not the job's process is left exactly as it is: rewriting the plist and issuing
 * bootout/bootstrap in front of a refusal is a mutation this install had no standing to make. An
 * owned listener answering with silence is no licence either: a restart cannot supply a build
 * identity this install never carried, so that refusal has to land here too, not after the bootout.
 */
async function refuseUnownedPort(
  config: Config,
  logDir: string,
  actions: HostActions,
  intended: IntendedService,
): Promise<void> {
  const port = config.operational.mcpPort;
  const ownership = await readPortOwnership(actions, port);
  if (ownership.kind === 'foreign') {
    throw new NativeSetupError(
      `port ${String(port)} is already held and the process holding it is not ${MCP_LAUNCH_LABEL}: ${ownership.reason}.`,
      bindingCommands(config, logDir),
    );
  }
  if (ownership.kind === 'unknown') {
    throw new NativeSetupError(
      `port ${String(port)} could not be read, and this install will not write a job over a port it cannot see: ${ownership.reason}.`,
      bindingCommands(config, logDir),
    );
  }
  if (ownership.kind === 'ours' && !isRealBuildSha(intended.buildSha)) {
    const reason = `this install carries no build identity, and the silent service on port ${String(port)} cannot be matched against one`;
    throw bindingRefusal({ kind: 'unverified', reason }, config, logDir);
  }
}

export async function prepareNativeService(
  config: Config,
  repoDir: string,
  write: Writer,
  seams: NativeServiceSeams = {},
): Promise<void> {
  const actions = seams.actions ?? HOST_ACTIONS;
  const home = seams.home ?? homedir();
  const readiness = seams.waitFor ?? waitForMcpHealth;
  const readHealth = seams.readHealth ?? readMcpHealth;
  const script = mcpScriptPath(repoDir);
  if (!existsSync(script)) {
    throw new NativeSetupError(
      `the native profile runs the MCP server from ${script}, which is not built:`,
      ['npm ci && npm run build', 'aion init --install native'],
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
  const environment = serviceEnvironment(envFilePath(repoDir), process.env);
  const plist = renderLaunchdPlist({
    nodePath: process.execPath,
    repoDir,
    environment,
    standardErrorPath: `${logDir}/aion-mcp.launchd.err.log`,
  });
  const intended: IntendedService = {
    port,
    buildSha: intendedBuildSha(environment),
    storePath: config.sqlite.path,
  };

  // The plist text decides whether a bound service is left alone, never whether the port is
  // looked at: a rewrite and bootout land on a machine this run has not earned the right to change.
  const unchanged = existsSync(plistPath) && readFileSync(plistPath, 'utf8') === plist;
  const serving = await readHealth(port);
  if (serving === undefined) {
    // Silence is not absence: a process can hold the port and never answer /health at all.
    await refuseUnownedPort(config, logDir, actions, intended);
  } else {
    const binding = await verifyServiceBinding(serving, intended, actions);
    if (binding.kind === 'unowned' || binding.kind === 'unverified') {
      // Somebody else's process, or our own running something unnameable. Reported, never
      // booted, signalled or replaced.
      throw bindingRefusal(binding, config, logDir);
    }
    if (binding.kind === 'bound' && unchanged) {
      // Idempotent: the job's own process, on this build, holding the configured store.
      write(
        `aion-mcp already running under ${MCP_LAUNCH_LABEL} (pid ${String(binding.pid)}, ` +
          `build ${binding.buildSha}, store ${binding.storeId})`,
      );
      return;
    }
    write(
      `replacing the service under ${MCP_LAUNCH_LABEL}: ${
        binding.kind === 'bound' ? 'the job file changed' : binding.reason
      }`,
    );
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
        `launchctl print ${launchdDomain()}/${MCP_LAUNCH_LABEL} | head -n 20`,
      ],
    );
  }

  // Readiness says something answered; the same three facts decide it's this install's service.
  const answered = await readHealth(port);
  if (answered === undefined) {
    throw new NativeSetupError(
      `the launchd job is loaded and the probe on port ${String(port)} stopped answering.`,
      bindingCommands(config, logDir),
    );
  }
  const binding = await verifyServiceBinding(answered, intended, actions);
  if (binding.kind !== 'bound') {
    throw bindingRefusal(binding, config, logDir);
  }
  write(
    `  aion-mcp healthy (pid ${String(binding.pid)}, build ${binding.buildSha}, ` +
      `store ${binding.storeId})`,
  );
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
  const domain = launchdDomain();
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
 * Stamps what this run installed. Read by `aion uninstall`, which removes only what it can prove
 * we put there and prints the manual command for everything else.
 *
 * The launchd job is recorded on darwin whether or not this run wrote it, because the path is the
 * one this build owns either way; the Neo4j facts are recorded only when init was the one that set
 * the server up, and the plugin jar only when init was the one that fetched it.
 */
export function recordNativeInstall(
  config: Config,
  repoDir: string,
  graph: NativeGraphRecord | undefined,
  write: Writer,
): void {
  const path = writeInstallManifest(config.operational.dataDir, {
    version: INSTALL_MANIFEST_VERSION,
    profile: config.install.profile,
    recordedAt: new Date().toISOString(),
    repoDir,
    dataDir: config.operational.dataDir,
    ...(process.platform === 'darwin' ? { launchdPlist: launchAgentPath(homedir()) } : {}),
    ...(graph === undefined
      ? {}
      : {
          neo4jHome: graph.neo4jHome,
          neo4jConfFile: graph.neo4jConfFile,
          neo4jSettings: NEO4J_SETTINGS,
          ...(graph.gdsJar === undefined ? {} : { gdsJar: graph.gdsJar }),
        }),
  });
  write(`recorded what this install put on the machine in ${path}`);
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
