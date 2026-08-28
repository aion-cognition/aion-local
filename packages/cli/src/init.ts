import { createInterface } from 'node:readline/promises';
import {
  bootstrapBackbone,
  ConfigError,
  ensureNeo4jPassword,
  GraphConnection,
  isManagedNeo4jUri,
  loadConfig,
  openLogger,
  provisionOllama,
  runGraphMigrations,
  SqliteStore,
  validateNeo4jEndpoint,
  type Config,
  type Logger,
  type ProvisionEvent,
} from '@aion/core';
import { USAGE_PROTOCOL } from '@aion/mcp';
import { composeRunner, MCP_PROFILE, MCP_SERVICE, NEO4J_SERVICE, startService, waitForMcpHealth } from './compose.js';
import { describeError, stderrWriter, stdoutWriter, type Writer } from './output.js';
import { envFilePath, envTemplatePath, resolveRepoDir } from './paths.js';

export const GIT_USER_NAME_ENV_VAR = 'AION_GIT_USER_NAME';

/** Neo4j's first boot downloads and installs the GDS plugin, which outlasts the 60s default. */
const NEO4J_READY_TIMEOUT_MS = 180_000;

export class UnknownOptionError extends Error {
  constructor(option: string) {
    super(`unknown option '${option}' for init (supported: --yes)`);
    this.name = 'UnknownOptionError';
  }
}

export class MemberNameUnavailableError extends Error {
  constructor() {
    super(
      `no member name available: ${GIT_USER_NAME_ENV_VAR} is empty and there is no terminal to ask on. ` +
        'Set `git config user.name` on the host, or run init from a terminal.',
    );
    this.name = 'MemberNameUnavailableError';
  }
}

export class Neo4jPasswordMissingError extends Error {
  constructor(uri: string) {
    super(`AION_NEO4J_PASSWORD is required for the external Neo4j at ${uri}`);
    this.name = 'Neo4jPasswordMissingError';
  }
}

export type InitFlags = {
  readonly assumeYes: boolean;
};

export function parseInitFlags(argv: readonly string[]): InitFlags {
  let assumeYes = false;
  for (const arg of argv) {
    if (arg === '--yes' || arg === '-y') {
      assumeYes = true;
      continue;
    }
    throw new UnknownOptionError(arg);
  }
  return { assumeYes };
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
      throw new MemberNameUnavailableError();
    }
    return fallback;
  }

  const suffix = fallback === '' ? '' : ` [${fallback}]`;
  const answer = (await input.ask(`Member name${suffix}: `)).trim();
  const chosen = answer === '' ? fallback : answer;
  if (chosen === '') {
    throw new MemberNameUnavailableError();
  }
  return chosen;
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

/** PRD §11 step 5. The one-time command that writes the server into Claude's user config; every future session then connects with no per-session setup. */
export function registrationCommand(port: number): string {
  return `claude mcp add -s user --transport http aion http://127.0.0.1:${String(port)}/mcp`;
}

/** Same registration, as the raw JSON Claude Code's own config uses for an HTTP MCP server — for manual edits and other harnesses. */
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

async function provisionGraph(config: Config, password: string, write: Writer, repoDir: string): Promise<void> {
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

async function initialize(config: Config, flags: InitFlags, write: Writer, logger: Logger): Promise<void> {
  const repoDir = resolveRepoDir();
  const managed = isManagedNeo4jUri(config.neo4j.uri);

  if (!managed && config.neo4j.password === '') {
    throw new Neo4jPasswordMissingError(config.neo4j.uri);
  }
  const password = managed
    ? ensureNeo4jPassword(envFilePath(repoDir), envTemplatePath(repoDir))
    : config.neo4j.password;
  if (managed) {
    write(`neo4j password ready in ${envFilePath(repoDir)}`);
  }

  await provisionGraph(config, password, write, repoDir);

  write(`provisioning ollama models at ${config.ollama.url}`);
  await provisionOllama(
    {
      baseUrl: config.ollama.url,
      embedModel: config.models.embed,
      embedDimension: config.models.embedDimension,
      cueModel: config.models.cue,
      reflectModel: config.models.reflect,
    },
    { onEvent: provisionReporter(write, logger) },
  );

  const memberName = await resolveMemberName({
    envName: process.env[GIT_USER_NAME_ENV_VAR],
    assumeYes: flags.assumeYes,
    interactive: process.stdin.isTTY === true,
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
  } finally {
    await connection.close();
    store.close();
  }

  await provisionMcpService(config, write, repoDir);
  renderRegistration(config.operational.mcpPort, write);
}

export async function runInit(argv: readonly string[] = [], write: Writer = stdoutWriter): Promise<number> {
  let flags: InitFlags;
  let config: Config;
  try {
    flags = parseInitFlags(argv);
    config = loadConfig(process.env);
  } catch (err) {
    stderrWriter(err instanceof ConfigError ? err.message : describeError(err));
    return 1;
  }

  const logger = openLogger({ ...config.logging, name: 'aion-init' });
  try {
    await initialize(config, flags, write, logger);
    write('\naion init: ready');
    return 0;
  } catch (err) {
    logger.error({ err: describeError(err) }, 'init failed');
    stderrWriter(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    return 1;
  }
}
