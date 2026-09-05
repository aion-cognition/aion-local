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

/** `bin/aion` exports the host repo path into the container, where nothing else can name it. */
export const HOST_REPO_ENV_VAR = 'AION_REPO_PATH';

export const HOOK_SCRIPT_RELATIVE = join('packages', 'cli', 'dist', 'hook-main.js');

export type HostRepo = {
  readonly path: string;
  /** False whenever the path cannot be checked from here, which is every run inside the CLI container. */
  readonly verified: boolean;
};

/**
 * Where the repo sits on the machine Claude Code runs on, which is not where this process
 * sits. The declared path wins outright: inside the container it names a directory that is
 * not there, and reading the container's own cwd instead would write container paths into
 * host settings.
 */
export function resolveHostRepo(
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): HostRepo {
  const declared = (env[HOST_REPO_ENV_VAR] ?? '').trim();
  const path = declared === '' ? cwd : declared;
  return { path, verified: existsSync(join(path, COMPOSE_FILE_NAME)) };
}

export function hookScriptPath(repoPath: string): string {
  return join(repoPath, HOOK_SCRIPT_RELATIVE);
}
