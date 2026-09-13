import {
  bootstrapBackbone,
  ensureNeo4jPassword,
  envFileValue,
  seedEnvFromTemplate,
  GraphConnection,
  isManagedNeo4jUri,
  loadConfig,
  provisionOllama,
  reconcileResidentModels,
  recordLifecycleEvent,
  resolveProviderRouting,
  routingSummary,
  GRAPH_SCHEMA_VERSION,
  runGraphMigrations,
  SqliteStore,
  validateNeo4jEndpoint,
  type Config,
  type Logger,
  type ProvisionEvent,
} from '@aion/core';
import { createInterface } from 'node:readline/promises';

import { CliUsageError, parseArgs, unknownOption, type ArgSpec } from './args.js';
import {
  composeRunner,
  MCP_PROFILE,
  MCP_SERVICE,
  NEO4J_SERVICE,
  startService,
  waitForMcpHealth,
} from './compose.js';
import { installFullProfile } from './hooks-cmd.js';
import {
  readStorePairing,
  refuseProfileSwitch,
  storePairingRefusal,
  upsertEnvValue,
  type InstallProfile,
} from './install-profile.js';
import { lifecycleIntakeDeps, type LifecycleTarget } from './lifecycle.js';
import { GIT_USER_NAME_ENV_VAR, resolveMemberName } from './member-name.js';
import {
  prepareNativeProfile,
  prepareNativeService,
  provisionNativeGraph,
  recordNativeInstall,
  reportNativeHealth,
  type NativeGraphRecord,
} from './native-install.js';
import { stdoutWriter, type Writer } from './output.js';
import { envFilePath, envTemplatePath, resolveRepoDir } from './paths.js';
import { renderRegistration } from './registration.js';
import { withSubstrate } from './substrate.js';

export const ANTHROPIC_KEY_ENV_VAR = 'AION_ANTHROPIC_API_KEY';

/** Neo4j's first boot downloads and installs the GDS plugin, which outlasts the 60s default. */
const NEO4J_READY_TIMEOUT_MS = 180_000;

const MISSING_ANTHROPIC_KEY =
  `the full profile routes generation to Anthropic and needs ${ANTHROPIC_KEY_ENV_VAR}. ` +
  'Set it in the environment or .env, or run `aion init full` from a terminal.';

/**
 * `local` is the substrate on its own: Ollama for every generation role. `full` adds an Anthropic
 * key, which routes generation there and is optional spend rather than a capability.
 *
 * Both install the Claude Code hooks, which make the recall and reflection cadence a schedule
 * rather than a judgment call. They used to be the keyed profile's alone, because the local model
 * of that build could not keep up with a capture every turn; it can, and a capture is worth
 * storing on either route.
 *
 * This is the generation profile; `--install` is the install profile, which is what the substrate
 * runs on, docker or native. Two different questions, and the second one is a flag because it is
 * asked once per install and read afterwards from config.
 *
 * `--profile` is accepted as an alias for `--install` and is not advertised. It is what the flag
 * was called for one release, and two things named "profile" in one usage line is the reason it
 * is not called that any more.
 */
export type InitProfile = 'local' | 'full';

const SPEC: ArgSpec = {
  command: 'init',
  usage: 'aion init [local | full] [--install docker | native] [--yes]',
  options: [
    { flag: '--yes', alias: '-y' },
    { flag: '--install', takesValue: true },
    { flag: '--profile', takesValue: true },
  ],
  maxPositionals: 1,
  supported: ['local', 'full', '--install', '--yes'],
};

export type InitFlags = {
  readonly assumeYes: boolean;
  readonly profile: InitProfile | undefined;
  /** Absent leaves whatever `AION_INSTALL_PROFILE` already says, which defaults to docker. */
  readonly install: InstallProfile | undefined;
};

export function parseInitFlags(argv: readonly string[]): InitFlags {
  const { flags, values, positionals } = parseArgs(SPEC, argv);
  const [profile] = positionals;
  if (profile !== undefined && profile !== 'local' && profile !== 'full') {
    throw unknownOption(SPEC, profile);
  }
  const flag = values.has('--install') ? '--install' : '--profile';
  const install = values.get(flag);
  if (install !== undefined && install !== 'docker' && install !== 'native') {
    throw new CliUsageError(`${flag} takes docker or native, not '${install}'`);
  }
  return { assumeYes: flags.has('--yes'), profile, install };
}

/**
 * The one run allowed to convert a docker-shaped `.env` instead of being refused by it.
 *
 * `--install native` is the request to record the host addresses, and `prepareNativeProfile`
 * rewrites the same three lines a few steps into the run. Without the flag this is a docker init
 * on a host, which has no host paths to convert them to.
 */
export function initConvertsContainerPaths(flags: InitFlags): boolean {
  return flags.install === 'native';
}

export type InitProfileInput = {
  readonly requested: InitProfile | undefined;
  readonly assumeYes: boolean;
  readonly interactive: boolean;
  readonly ask: (question: string) => Promise<string>;
};

/** Local is the default everywhere it cannot be asked, because full changes how sessions behave. */
export async function resolveInitProfile(input: InitProfileInput): Promise<InitProfile> {
  if (input.requested !== undefined) {
    return input.requested;
  }
  if (input.assumeYes || !input.interactive) {
    return 'local';
  }
  const answer = (await input.ask('Profile, local or full [local]: ')).trim().toLowerCase();
  return answer === 'full' ? 'full' : 'local';
}

export type AnthropicKeyInput = {
  readonly configured: string;
  readonly fromEnvFile: string | undefined;
  readonly assumeYes: boolean;
  readonly interactive: boolean;
  readonly ask: (question: string) => Promise<string>;
};

/**
 * The key `aion init full` settles. It is asked for because `full` is the profile that routes
 * generation to Anthropic, and a profile that names a provider with no credential for it is a
 * request nobody can serve. Every other install needs no key for anything, hooks included.
 */
export async function resolveAnthropicKey(input: AnthropicKeyInput): Promise<string> {
  const existing = (input.configured === '' ? (input.fromEnvFile ?? '') : input.configured).trim();
  if (existing !== '') {
    return existing;
  }
  if (input.assumeYes || !input.interactive) {
    throw new CliUsageError(MISSING_ANTHROPIC_KEY);
  }
  const answer = (await input.ask('Anthropic API key: ')).trim();
  if (answer === '') {
    throw new CliUsageError(MISSING_ANTHROPIC_KEY);
  }
  return answer;
}

async function askOnTerminal(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/**
 * Pull streams emit a line per chunk; only status transitions are worth a line of output.
 * The full event stream still reaches the log.
 */
function provisionReporter(write: Writer, logger: Logger): (event: ProvisionEvent) => void {
  let lastStatus = '';
  return (event) => {
    logger.debug({ event }, 'ollama provisioning');
    if (event.type === 'reachable') {
      write('  ollama reachable');
      return;
    }
    if (event.type === 'pull_progress') {
      const key = `${event.model}:${event.status}`;
      if (key === lastStatus) {
        return;
      }
      lastStatus = key;
      write(`  pull ${event.model}: ${event.status}`);
      return;
    }
    if (event.type === 'pull_done') {
      write(`  pull ${event.model}: done`);
      return;
    }
    write(`  verify ${event.model} (${event.kind}): ok`);
  };
}

async function provisionMcpService(config: Config, write: Writer, repoDir: string): Promise<void> {
  if (config.install.profile === 'native') {
    await prepareNativeService(config, repoDir, write);
    return;
  }
  write(`starting compose service ${MCP_SERVICE}`);
  await startService(composeRunner(repoDir), MCP_SERVICE, MCP_PROFILE);
  write(`waiting for aion-mcp health on port ${String(config.operational.mcpPort)}`);
  await waitForMcpHealth(config.operational.mcpPort);
  write('  aion-mcp healthy');
}

async function provisionGraph(
  config: Config,
  password: string,
  write: Writer,
  repoDir: string,
): Promise<NativeGraphRecord | undefined> {
  if (config.install.profile === 'native') {
    return await provisionNativeGraph(config, password, write);
  }
  if (isManagedNeo4jUri(config.neo4j.uri)) {
    write(`starting compose service ${NEO4J_SERVICE}`);
    await startService(composeRunner(repoDir), NEO4J_SERVICE);
  } else {
    write(`using external Neo4j at ${config.neo4j.uri}`);
  }

  write(`waiting for Bolt at ${config.neo4j.uri}`);
  const { gdsVersion } = await validateNeo4jEndpoint(
    { uri: config.neo4j.uri, password },
    { timeoutMs: NEO4J_READY_TIMEOUT_MS },
  );
  write(`  bolt ready, graph-data-science ${gdsVersion}`);
  return undefined;
}

type LifecycleSubstrate = LifecycleTarget & {
  /** True when this init is the one that created the backbone, which is the substrate's birth. */
  readonly created: boolean;
};

/**
 * What the substrate remembers about the run that made it. The fresh case is the birth event,
 * and the only other thing an init changes about the substrate itself is the schema it runs on,
 * so an existing substrate records an event only when the schema was recorded for the first time.
 */
async function recordInit(
  target: LifecycleSubstrate,
  applied: boolean,
  memberName: string,
  profile: InitProfile,
): Promise<void> {
  const deps = await lifecycleIntakeDeps(target);
  if (target.created) {
    await recordLifecycleEvent(deps, {
      event: 'substrate_initialized',
      text: `substrate initialized: backbone created for ${memberName}, profile ${profile}`,
    });
    return;
  }
  if (applied) {
    await recordLifecycleEvent(deps, {
      event: 'schema_recorded',
      text: `graph schema version ${String(GRAPH_SCHEMA_VERSION)} recorded on an existing substrate`,
    });
  }
}

async function initialize(
  config: Config,
  flags: InitFlags,
  profile: InitProfile,
  write: Writer,
  logger: Logger,
): Promise<void> {
  const repoDir = resolveRepoDir();
  // Either profile's own server: compose's, or the one the native profile installs and starts.
  // Both get a generated password recorded in `.env`, because the install that owns the server is
  // the install that can set it. Anything else is a server somebody else runs, and its password
  // is theirs to supply.
  const owned = isManagedNeo4jUri(config.neo4j.uri) || config.install.profile === 'native';

  if (!owned && config.neo4j.password === '') {
    throw new CliUsageError(
      `AION_NEO4J_PASSWORD is required for the external Neo4j at ${config.neo4j.uri}`,
    );
  }
  const password = owned
    ? ensureNeo4jPassword(envFilePath(repoDir), envTemplatePath(repoDir))
    : config.neo4j.password;
  if (owned) {
    write(`neo4j password ready in ${envFilePath(repoDir)}`);
  }

  const graph = await provisionGraph(config, password, write, repoDir);

  // One model to pull: generation runs remotely and the embedder is the vector index.
  const routing = resolveProviderRouting(config);
  write(`provisioning ollama models at ${config.ollama.url}`);
  write(`  routing ${routingSummary(routing)}`);
  await provisionOllama(
    {
      baseUrl: config.ollama.url,
      embedModel: config.models.embed,
      embedDimension: config.models.embedDimension,
    },
    { onEvent: provisionReporter(write, logger) },
  );

  const reconciliation = await reconcileResidentModels({
    baseUrl: config.ollama.url,
    embedModel: config.models.embed,
  });
  logger.info({ reconciliation }, 'model reconciliation finished');
  write(`  reconcile ${reconciliation.detail}`);

  const memberName = await resolveMemberName({
    envName: process.env[GIT_USER_NAME_ENV_VAR],
    assumeYes: flags.assumeYes,
    interactive: process.stdin.isTTY,
    ask: askOnTerminal,
  });

  const store = new SqliteStore({ filePath: config.sqlite.path });
  const connection = new GraphConnection({ uri: config.neo4j.uri, password });
  try {
    // Before the migrations, because running them is what makes a dropped database look like a
    // fresh one and hides that the graph beside it is not.
    const pairing = await readStorePairing(connection.driver, store.db);
    if (pairing !== 'fresh' && pairing !== 'paired') {
      throw new CliUsageError(
        storePairingRefusal(pairing, config.install.profile, config.operational.dataDir).join('\n'),
      );
    }

    const { applied, created } = await runGraphMigrations(connection.driver, store.db, {
      embedDimension: config.models.embedDimension,
    });
    write(
      created.length === 0
        ? 'graph schema already current'
        : `graph schema: created ${created.join(', ')}`,
    );

    const backbone = await bootstrapBackbone(connection.driver, { memberName });
    write(
      `backbone: Member "${memberName}" ${backbone.member.created ? 'created' : 'present'}, ` +
        `global Workspace ${backbone.workspace.created ? 'created' : 'present'}`,
    );
    logger.info({ applied, created, backbone, memberName }, 'init finished');

    // Recorded before the service starts, so the drain the service opens with is what enriches
    // the substrate's first memory.
    await recordInit(
      {
        connection,
        db: store.db,
        config,
        logger,
        memberId: backbone.member.id,
        workspaceId: backbone.workspace.id,
        created: backbone.member.created,
      },
      applied,
      memberName,
      profile,
    );
  } finally {
    await connection.close();
    store.close();
  }

  await provisionMcpService(config, write, repoDir);
  if (config.install.profile === 'native') {
    // What this run put on the machine, so `aion uninstall` can tell it apart from what was
    // already here. Written after the service is up, since that is the last thing init installs.
    recordNativeInstall(config, repoDir, graph, write);
    // The whole machine changed in this run, so it closes with the report that judges it rather
    // than with a summary written here. The docker profile ends where it always has.
    await reportNativeHealth(config, password, write);
  }
  renderRegistration(config.operational.mcpPort, write);
}

/**
 * The key is settled before the substrate comes up, not after. Provisioning reads routing to
 * decide which local models are worth pulling, and the MCP service it starts reads `.env`
 * once at boot, so a key written afterwards would leave both on the local path until the next
 * restart.
 */
async function prepareFullProfile(
  config: Config,
  flags: InitFlags,
  write: Writer,
): Promise<Config> {
  const repoDir = resolveRepoDir();
  const envPath = envFilePath(repoDir);
  // Writing the key into a missing .env would create a bare two-line file and the
  // template copy inside ensureNeo4jPassword would never fire; seed it here first so a
  // fresh install's .env carries the full documented surface, not just what init wrote.
  seedEnvFromTemplate(envPath, envTemplatePath(repoDir));
  const key = await resolveAnthropicKey({
    configured: config.anthropic.apiKey,
    fromEnvFile: envFileValue(envPath, ANTHROPIC_KEY_ENV_VAR),
    assumeYes: flags.assumeYes,
    interactive: process.stdin.isTTY,
    ask: askOnTerminal,
  });
  if (key === config.anthropic.apiKey) {
    return config;
  }
  upsertEnvValue(envPath, ANTHROPIC_KEY_ENV_VAR, key);
  process.env[ANTHROPIC_KEY_ENV_VAR] = key;
  write(`anthropic key recorded in ${envPath}`);
  return loadConfig(process.env);
}

export function runInit(
  argv: readonly string[] = [],
  write: Writer = stdoutWriter,
): Promise<number> {
  return withSubstrate({
    spec: SPEC,
    argv,
    write,
    parse: parseInitFlags,
    convertsContainerPaths: initConvertsContainerPaths,
    run: async (substrate, flags) => {
      // Provisioning opens its own store and connection against the password it just settled,
      // which the shared lifecycle cannot know before this point.
      const { config } = substrate;
      // First line, because it is the answer to "where did it put everything" and because a run
      // that is about to write to the wrong place should say so before it does.
      write(`data root ${config.operational.dataDir}`);
      const logger = substrate.logger();
      const profile = await resolveInitProfile({
        requested: flags.profile,
        assumeYes: flags.assumeYes,
        interactive: process.stdin.isTTY,
        ask: askOnTerminal,
      });
      refuseProfileSwitch(flags.install, config.install.profile);
      // The addresses first, the key second: both rewrite `.env` and re-read config, and the key
      // is settled against the substrate this install is actually going to talk to.
      const based =
        flags.install === 'native' ? prepareNativeProfile(write, resolveRepoDir()) : config;
      const resolved = profile === 'full' ? await prepareFullProfile(based, flags, write) : based;

      await initialize(resolved, flags, profile, write, logger);

      write('');
      // Every profile, because hooks are route-agnostic: they capture a turn and hand it to
      // whichever generation route this install resolved, and the local one is a route. The
      // generation profile decides where that digest runs and what it costs, not whether the
      // substrate is allowed to remember.
      installFullProfile(write);
      if (profile !== 'full') {
        write('Hooks run on the local route. `aion init full` adds a key and routes them to');
        write('Anthropic instead; see docs/harness.md.');
      }
      write('\naion init: ready');
      return 0;
    },
  });
}
