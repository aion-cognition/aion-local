import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HEALTH_PATH, runningInContainer } from '@aion/mcp';
import { COMPOSE_FILE_NAME } from './paths.js';

const execFileAsync = promisify(execFile);

export const NEO4J_SERVICE = 'neo4j';
export const MCP_SERVICE = 'aion-mcp';
export const MCP_PROFILE = 'mcp';

/**
 * The CLI itself runs inside `aion-cli`, a container on the same compose network as
 * `aion-mcp` — its published `127.0.0.1:<port>` reaches the *host's* loopback, which is
 * not this container's, so the compose service DNS name is the only address that resolves
 * from in here. A bare-metal CLI run (dev, outside Docker) has no such network and reaches
 * the service the same way a registered `claude` session on the host does.
 */
export function mcpBaseUrl(port: number): string {
  const host = runningInContainer() ? MCP_SERVICE : '127.0.0.1';
  return `http://${host}:${String(port)}`;
}

export class ComposeCommandError extends Error {
  readonly args: readonly string[];

  constructor(args: readonly string[], detail: string, options?: { cause?: unknown }) {
    super(`docker compose ${args.join(' ')} failed: ${detail}`, options);
    this.name = 'ComposeCommandError';
    this.args = args;
  }
}

export type ComposeRunner = (args: readonly string[]) => Promise<string>;

/**
 * The CLI container mounts the docker socket, so `docker compose` here drives the same
 * daemon and the same project the host wrapper used. `-f <repo>/compose.yaml` also fixes
 * the project directory, which is what makes compose read the `.env` init just wrote.
 */
export function composeRunner(repoDir: string): ComposeRunner {
  return async (args) => {
    const full = ['compose', '-f', `${repoDir}/${COMPOSE_FILE_NAME}`, ...args];
    try {
      const { stdout, stderr } = await execFileAsync('docker', full, { cwd: repoDir });
      return `${stdout}${stderr}`.trim();
    } catch (err) {
      const stderr = (err as { stderr?: string }).stderr;
      const detail = stderr === undefined || stderr.trim() === '' ? String(err) : stderr.trim();
      throw new ComposeCommandError(args, detail, { cause: err });
    }
  };
}

/**
 * `--profile` is explicit rather than relied on implicitly: compose v2.24+ also starts a
 * profiled service addressed by name without it, but pinning the flag keeps this working
 * on older installs too.
 */
export async function startService(run: ComposeRunner, service: string, profile?: string): Promise<string> {
  const args = profile === undefined ? ['up', '-d', service] : ['--profile', profile, 'up', '-d', service];
  return run(args);
}

export class McpServiceNotReadyError extends Error {
  constructor(port: number, timeoutMs: number, options?: { cause?: unknown }) {
    super(`aion-mcp on port ${String(port)} did not answer ${HEALTH_PATH} within ${String(timeoutMs)}ms`, options);
    this.name = 'McpServiceNotReadyError';
  }
}

export type McpReadinessOptions = {
  timeoutMs?: number;
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch;
};

const DEFAULT_MCP_READY_TIMEOUT_MS = 60_000;
const DEFAULT_MCP_READY_POLL_INTERVAL_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Polls the liveness endpoint (PRD §4): it never touches Neo4j or Ollama, so a 200 here means the process is up, nothing more. */
export async function waitForMcpHealth(port: number, options: McpReadinessOptions = {}): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_MCP_READY_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_MCP_READY_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(`${mcpBaseUrl(port)}${HEALTH_PATH}`);
      if (response.ok) {
        return;
      }
      lastError = new Error(`unhealthy response: ${String(response.status)}`);
    } catch (err) {
      lastError = err;
    }
    await sleep(pollIntervalMs);
  }

  throw new McpServiceNotReadyError(port, timeoutMs, { cause: lastError });
}
