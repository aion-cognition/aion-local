import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { COMPOSE_FILE_NAME } from './paths.js';

const execFileAsync = promisify(execFile);

export const NEO4J_SERVICE = 'neo4j';

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

export async function startService(run: ComposeRunner, service: string): Promise<string> {
  return run(['up', '-d', service]);
}
