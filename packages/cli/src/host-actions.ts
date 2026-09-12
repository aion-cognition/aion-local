import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';

import { CliUsageError } from './args.js';

const execFileAsync = promisify(execFile);

/**
 * The seam between the install steps and the machine they change.
 *
 * Everything that installs, starts, loads or downloads goes through one of these two functions, so
 * a test can watch the whole sequence without a package manager, a service or a network anywhere
 * near it. The real implementations are at the bottom of the file and are the only place in the
 * CLI that runs an unbounded host command.
 */

export type HostResult = {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
};

export type HostRun = (program: string, args: readonly string[]) => Promise<HostResult>;

/** Downloads to `target` and answers the digest of what arrived. The caller decides on it. */
export type HostFetch = (url: string, target: string) => Promise<{ sha256: string; bytes: number }>;

export type HostActions = {
  readonly run: HostRun;
  readonly fetch: HostFetch;
};

/**
 * A setup step that could not finish, with the commands that finish it by hand.
 *
 * Every one of these is a step init tried to take and could not: a package manager that is not
 * there, a privilege it does not have, a download that did not match. The remedy is the exact
 * command, because the fallback experience has to be "run this, then run init again" and never a
 * checklist to assemble.
 */
export class NativeSetupError extends CliUsageError {
  readonly commands: readonly string[];

  constructor(message: string, commands: readonly string[]) {
    super([message, ...commands.map((command) => `  ${command}`)].join('\n'));
    this.name = 'NativeSetupError';
    this.commands = commands;
  }
}

export async function hostRun(program: string, args: readonly string[]): Promise<HostResult> {
  try {
    const { stdout, stderr } = await execFileAsync(program, [...args], {
      maxBuffer: 8 * 1024 * 1024,
    });
    return { ok: true, stdout, stderr };
  } catch (err) {
    const failure = err as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? failure.message ?? 'command failed',
    };
  }
}

/**
 * Fetch, hash and write in one pass over the body, then move into place. The download lands beside
 * its target under a `.part` name so an interrupted fetch cannot leave a half file where the
 * database would load it, and the digest is taken from the bytes that were written rather than
 * from a second read of the file.
 */
export async function hostFetch(
  url: string,
  target: string,
): Promise<{ sha256: string; bytes: number }> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${String(response.status)} from ${url}`);
  }
  const body = Buffer.from(await response.arrayBuffer());
  const part = `${target}.part`;
  writeFileSync(part, body);
  try {
    renameSync(part, target);
  } catch (err) {
    rmSync(part, { force: true });
    throw err;
  }
  return { sha256: createHash('sha256').update(body).digest('hex'), bytes: body.byteLength };
}

export const HOST_ACTIONS: HostActions = { run: hostRun, fetch: hostFetch };
