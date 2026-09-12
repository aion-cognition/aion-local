import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { DEFAULT_LOG_FILE } from '../logging/logger.js';
import { DEFAULT_SQLITE_PATH } from '../sqlite/database.js';

/**
 * Where a process keeps the substrate's files, decided before anything opens one.
 *
 * The three path defaults in the knob table are container paths: `/data`, `/data/aion.sqlite`,
 * `/data/logs/aion.jsonl`. That is correct where the CLI has always run, which is inside
 * `aion-cli` with the data volume mounted there. On a host it is a directory that does not exist
 * and cannot be created, and the first thing any command opens is the logger: the first real
 * `aion init --install native` died on `ENOENT: mkdir '/data/logs'` before it had printed a line.
 *
 * So the defaults are resolved against the machine rather than pinned to one of them. This is
 * deliberately not a wrapper exporting variables: `node packages/cli/dist/main.js` run straight
 * from a host must not reach for `/data` either, and only code in the process can promise that.
 *
 * It is also deliberately not a change to the knob table. A default that read the machine would
 * put a developer's home directory in the committed config-surface capture and make the same
 * table produce different defaults in CI and on a laptop. The table keeps the container paths and
 * this seeds the environment the loader reads, which is the same mechanism an operator pinning
 * `AION_DATA_DIR` uses — and theirs still wins.
 */

/** The directory a host install keeps both of its own stores and its log under. */
export const HOST_DATA_DIR_NAME = '.aion';

export function hostDataDir(home: string = homedir()): string {
  return join(home, HOST_DATA_DIR_NAME);
}

export const DATA_DIR_ENV_VAR = 'AION_DATA_DIR';
export const SQLITE_PATH_VAR = 'AION_SQLITE_PATH';
export const LOG_FILE_VAR = 'AION_LOG_FILE';

export type SubstrateRoots = {
  readonly dataDir: string;
  readonly sqlitePath: string;
  readonly logFile: string;
  /** True where the container defaults are the right ones and nothing was seeded. */
  readonly inContainer: boolean;
  /** The variables the environment had already set, which are left exactly as they were. */
  readonly pinned: readonly string[];
};

/** The one fact everything here turns on. Docker writes this file into every container it runs. */
export function runningInContainer(): boolean {
  return existsSync('/.dockerenv');
}

function containerRoots(env: NodeJS.ProcessEnv): SubstrateRoots {
  return {
    dataDir: env[DATA_DIR_ENV_VAR] ?? '/data',
    sqlitePath: env[SQLITE_PATH_VAR] ?? DEFAULT_SQLITE_PATH,
    logFile: env[LOG_FILE_VAR] ?? DEFAULT_LOG_FILE,
    inContainer: true,
    pinned: [],
  };
}

export type SubstrateRootOptions = {
  readonly home?: string;
  /** Injected by tests; the probe above answers it in a real run. */
  readonly inContainer?: boolean;
  /** Off for a caller that only wants to know where the files would go. */
  readonly create?: boolean;
};

/**
 * Seeds the three path variables for a host run and answers where they point.
 *
 * Called by every entry point before it loads config: the CLI's shared lifecycle and the service
 * bootstrap. Inside a container it changes nothing at all, since the defaults the table carries
 * are already the mounted volume. On a host, a variable that is already set is left alone and
 * reported as pinned, so an operator who moved the data directory keeps it and one who moved only
 * the log file gets the directory default for the rest.
 *
 * The log directory is created here rather than left to the logger. The logger's destination makes
 * one level of directory and fails on a missing parent, which is exactly the crash this exists to
 * stop, and creating it is the one filesystem act a process can take before it can report anything.
 */
export function prepareSubstrateRoots(
  out: NodeJS.ProcessEnv = process.env,
  options: SubstrateRootOptions = {},
): SubstrateRoots {
  if (options.inContainer ?? runningInContainer()) {
    return containerRoots(out);
  }
  const pinned = [DATA_DIR_ENV_VAR, SQLITE_PATH_VAR, LOG_FILE_VAR].filter(
    (name) => (out[name] ?? '').trim() !== '',
  );
  const dataDir = (out[DATA_DIR_ENV_VAR] ?? '').trim() || hostDataDir(options.home);
  const sqlitePath = (out[SQLITE_PATH_VAR] ?? '').trim() || join(dataDir, 'aion.sqlite');
  const logFile = (out[LOG_FILE_VAR] ?? '').trim() || join(dataDir, 'logs', 'aion.jsonl');
  out[DATA_DIR_ENV_VAR] = dataDir;
  out[SQLITE_PATH_VAR] = sqlitePath;
  out[LOG_FILE_VAR] = logFile;
  if (options.create !== false) {
    mkdirSync(dirname(logFile), { recursive: true });
  }
  return { dataDir, sqlitePath, logFile, inContainer: false, pinned };
}
