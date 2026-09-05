import {
  bootstrapBackbone,
  ensureNeo4jPassword,
  envFileValue,
  seedEnvFromTemplate,
  GraphConnection,
  isManagedNeo4jUri,
  loadConfig,
  localChatModels,
  provisionOllama,
  reconcileResidentModels,
  recordLifecycleEvent,
  resolveProviderRouting,
  routingSummary,
  runGraphMigrations,
  SqliteStore,
  validateNeo4jEndpoint,
  type Config,
  type Logger,
  type ProvisionEvent,
} from '@aion/core';
import { USAGE_PROTOCOL } from '@aion/mcp';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
import { lifecycleIntakeDeps, type LifecycleTarget } from './lifecycle.js';
import { stdoutWriter, type Writer } from './output.js';
import { envFilePath, envTemplatePath, resolveRepoDir } from './paths.js';
import { withSubstrate } from './substrate.js';

export const GIT_USER_NAME_ENV_VAR = 'AION_GIT_USER_NAME';

export const ANTHROPIC_KEY_ENV_VAR = 'AION_ANTHROPIC_API_KEY';

/** Neo4j's first boot downloads and installs the GDS plugin, which outlasts the 60s default. */
const NEO4J_READY_TIMEOUT_MS = 180_000;

const MISSING_ANTHROPIC_KEY =
  `the full profile routes generation to Anthropic and needs ${ANTHROPIC_KEY_ENV_VAR}. ` +
  'Set it in the environment or .env, or run `aion init full` from a terminal.';

const MISSING_MEMBER_NAME =
  `no member name available: ${GIT_USER_NAME_ENV_VAR} is empty and there is no terminal to ask on. ` +
  'Set `git config user.name` on the host, or run init from a terminal.';

/**
 * `local` is the substrate on its own: Ollama for every generation role, no harness hooks.
 * `full` adds the Anthropic key and the Claude Code shims that make the recall and reflection
 * cadence a schedule rather than a judgment call.
 */
export type InitProfile = 'local' | 'full';

const SPEC: ArgSpec = {
  command: 'init',
  usage: 'aion init [local | full] [--yes]',
  options: [{ flag: '--yes', alias: '-y' }],
  maxPositionals: 1,
  supported: ['local', 'full', '--yes'],
};

export type InitFlags = {
  readonly assumeYes: boolean;
  readonly profile: InitProfile | undefined;
};

export function parseInitFlags(argv: readonly string[]): InitFlags {
  const { flags, positionals } = parseArgs(SPEC, argv);
  const [profile] = positionals;
  if (profile !== undefined && profile !== 'local' && profile !== 'full') {
    throw unknownOption(SPEC, profile);
  }
  return { assumeYes: flags.has('--yes'), profile };
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

export type MemberNameInput = {
  readonly envName: string | undefined;
  readonly assumeYes: boolean;
  readonly interactive: boolean;
  readonly ask: (question: string) => Promise<string>;
};

/**
 * `bin/aion` passes `git config user.name` through. Confirming it needs a terminal, so
 * `--yes` and the non-interactive case (the exit gate, CI) take it as given rather than
 * hanging on a prompt nobody can answer.
 */
export async function resolveMemberName(input: MemberNameInput): Promise<string> {
  const fallback = (input.envName ?? '').trim();

  if (input.assumeYes || !input.interactive) {
    if (fallback === '') {
      throw new CliUsageError(MISSING_MEMBER_NAME);
    }
    return fallback;
  }

  const suffix = fallback === '' ? '' : ` [${fallback}]`;
  const answer = (await input.ask(`Member name${suffix}: `)).trim();
  const chosen = answer === '' ? fallback : answer;
  if (chosen === '') {
    throw new CliUsageError(MISSING_MEMBER_NAME);
  }
  return chosen;
}

function upsertEnvValue(path: string, key: string, value: string): void {
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n') : [];
  const index = lines.findIndex((entry) => entry.startsWith(`${key}=`));
  const entry = `${key}=${value}`;
  if (index === -1) {
    lines.push(entry);
  } else {
    lines[index] = entry;
  }
  writeFileSync(path, lines.join('\n'));
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

/** The one-time command that writes the server into Claude's user config. Every future session then connects with no per-session setup. */
export function registrationCommand(port: number): string {
  return `claude mcp add -s user --transport http aion http://127.0.0.1:${String(port)}/mcp`;
}

/** Same registration, as the raw JSON Claude Code's own config uses for an HTTP MCP server. For manual edits and other harnesses. */
export function registrationJson(port: number): string {
  return JSON.stringify(
    { mcpServers: { aion: { type: 'http', url: `http://127.0.0.1:${String(port)}/mcp` } } },
    null,
    2,
  );
}

function renderRegistration(port: number, write: Writer): void {
  write('');
  write('MCP registration (one time; every future Claude Code session connects automatically):');
  write(`  ${registrationCommand(port)}`);
  write('');
  write('Equivalent raw JSON, for manual config or other harnesses:');
  write(registrationJson(port));
  write('');
  write('Add to your CLAUDE.md so the agent knows when to call recall and reflection:');
  write('');
  write(USAGE_PROTOCOL);
}

async function provisionMcpService(config: Config, write: Writer, repoDir: string): Promise<void> {
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
): Promise<void> {
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
}

type LifecycleSubstrate = LifecycleTarget & {
  /** True when this init is the one that created the backbone, which is the substrate's birth. */
  readonly created: boolean;
};

/**
 * What the substrate remembers about the run that made it. The fresh case is the birth event,
 * and the only other thing an init changes about the substrate itself is the schema it runs on,
 * so an existing substrate records an event only when a migration actually applied.
 */
async function recordInit(
  target: LifecycleSubstrate,
  applied: readonly number[],
  memberName: string,
  profile: InitProfile,
): Promise<void> {
  const deps = lifecycleIntakeDeps(target);
  if (target.created) {
    await recordLifecycleEvent(deps, {
      event: 'substrate_initialized',
      text:
        `substrate initialized: ${String(applied.length)} migrations applied, ` +
        `backbone created for ${memberName}, profile ${profile}`,
    });
    return;
  }
  if (applied.length > 0) {
    await recordLifecycleEvent(deps, {
      event: 'migrations_applied',
      text: `graph schema advanced: migrations ${applied.join(', ')} applied on an existing substrate`,
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
  const managed = isManagedNeo4jUri(config.neo4j.uri);

  if (!managed && config.neo4j.password === '') {
    throw new CliUsageError(
      `AION_NEO4J_PASSWORD is required for the external Neo4j at ${config.neo4j.uri}`,
    );
  }
  const password = managed
    ? ensureNeo4jPassword(envFilePath(repoDir), envTemplatePath(repoDir))
    : config.neo4j.password;
  if (managed) {
    write(`neo4j password ready in ${envFilePath(repoDir)}`);
  }

  await provisionGraph(config, password, write, repoDir);

  // Routing decides what is worth downloading: a role that routes to Anthropic has no local
  // model to pull, and reconciliation then unloads whatever an earlier local run left resident.
  const routing = resolveProviderRouting(config);
  write(`provisioning ollama models at ${config.ollama.url}`);
  write(`  routing ${routingSummary(routing)}`);
  await provisionOllama(
    {
      baseUrl: config.ollama.url,
      embedModel: config.models.embed,
      embedDimension: config.models.embedDimension,
      chatModels: localChatModels(routing),
    },
    { onEvent: provisionReporter(write, logger) },
  );

  const reconciliation = await reconcileResidentModels({ baseUrl: config.ollama.url, routing });
  logger.info({ reconciliation }, 'model reconciliation finished');
  if (reconciliation.checked) {
    write(`  reconcile ${reconciliation.detail}`);
  }

  const memberName = await resolveMemberName({
    envName: process.env[GIT_USER_NAME_ENV_VAR],
    assumeYes: flags.assumeYes,
    interactive: process.stdin.isTTY,
    ask: askOnTerminal,
  });

  const store = new SqliteStore({ filePath: config.sqlite.path });
  const connection = new GraphConnection({ uri: config.neo4j.uri, password });
  try {
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
    run: async (substrate, flags) => {
      // Provisioning opens its own store and connection against the password it just settled,
      // which the shared lifecycle cannot know before this point.
      const { config } = substrate;
      const logger = substrate.logger();
      const profile = await resolveInitProfile({
        requested: flags.profile,
        assumeYes: flags.assumeYes,
        interactive: process.stdin.isTTY,
        ask: askOnTerminal,
      });
      const resolved = profile === 'full' ? await prepareFullProfile(config, flags, write) : config;

      await initialize(resolved, flags, profile, write, logger);

      write('');
      if (profile === 'full') {
        installFullProfile(write);
      } else {
        write('The local profile is MCP-only: intake is the reflection tool, and no hooks run.');
        write('Hooks come with `aion init full`, which asks for a key; see docs/harness.md.');
      }
      write('\naion init: ready');
      return 0;
    },
  });
}
