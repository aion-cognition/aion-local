import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** compose.yaml mounts the host repo here; `working_dir` makes it the CLI's cwd. */
export const REPO_MOUNT = '/repo';

export const COMPOSE_FILE_NAME = 'compose.yaml';
export const ENV_FILE_NAME = '.env';
export const ENV_TEMPLATE_NAME = '.env.example';

export class RepoNotFoundError extends Error {
  constructor(searched: readonly string[]) {
    super(
      `no ${COMPOSE_FILE_NAME} found in ${searched.join(' or ')}; run this through ./bin/aion from the repo`,
    );
    this.name = 'RepoNotFoundError';
  }
}

/**
 * The repo is the CLI's cwd inside the container and the wrapper's own directory on the
 * host; both are checked so the commands also run outside a container during development.
 */
export function resolveRepoDir(cwd: string = process.cwd()): string {
  const candidates = cwd === REPO_MOUNT ? [REPO_MOUNT] : [cwd, REPO_MOUNT];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, COMPOSE_FILE_NAME))) {
      return candidate;
    }
  }
  throw new RepoNotFoundError(candidates);
}

export function envFilePath(repoDir: string): string {
  return join(repoDir, ENV_FILE_NAME);
}

export function envTemplatePath(repoDir: string): string {
  return join(repoDir, ENV_TEMPLATE_NAME);
}
