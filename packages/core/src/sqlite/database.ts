import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export const SQLITE_PATH_ENV_VAR = 'AION_SQLITE_PATH';

/** In-container path on the aion-data volume. Host-run tests override it. */
export const DEFAULT_SQLITE_PATH = '/data/aion.sqlite';

export const DEFAULT_BUSY_TIMEOUT_MS = 5000;

const BOOTSTRAP_MAX_ATTEMPTS = 25;
const BOOTSTRAP_RETRY_DELAY_MS = 20;

export type SqliteHandle = InstanceType<typeof Database>;

export type SqliteTarget = {
  filePath: string;
  busyTimeoutMs?: number;
};

const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS ops_ledger (
    key TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL,
    summary_json TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS reflection_queue (
    id TEXT PRIMARY KEY,
    job_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    enqueued_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    claimed_at TEXT,
    claimed_by TEXT,
    last_error TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS reinforcement_queue (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    trigger TEXT NOT NULL,
    ts TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS last_pack (
    session_id TEXT PRIMARY KEY,
    pack_json TEXT NOT NULL,
    ts TEXT NOT NULL
  )`,
];

/**
 * Bootstrap resolution for the one SQLite knob, used before the config module is
 * available. The config module owns the rest of the AION_* catalog and passes a
 * SqliteTarget in directly, mirroring logging's logTargetFromEnv.
 */
export function sqlitePathFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env[SQLITE_PATH_ENV_VAR] ?? DEFAULT_SQLITE_PATH;
}

function ensureDirectoryExists(filePath: string): void {
  if (filePath === ':memory:') {
    return;
  }
  mkdirSync(dirname(filePath), { recursive: true });
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * A brand-new file's first switch to WAL needs a brief exclusive lock that two
 * connections opening at the same instant can race for; busy_timeout does not cover
 * that specific window (SQLite issues SQLITE_BUSY for it immediately, no wait), so
 * bootstrap retries the whole open-and-migrate step itself instead of surfacing the
 * race to the caller. Once a file is already in WAL mode, re-opening it never hits
 * this path — verified with two connections racing a fresh file in test.
 */
export function openSqliteHandle(target: SqliteTarget): SqliteHandle {
  const busyTimeoutMs = target.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  ensureDirectoryExists(target.filePath);

  for (let attempt = 1; attempt <= BOOTSTRAP_MAX_ATTEMPTS; attempt += 1) {
    const db = new Database(target.filePath);
    try {
      db.pragma(`busy_timeout = ${busyTimeoutMs}`);
      db.pragma('journal_mode = WAL');
      for (const statement of SCHEMA_STATEMENTS) {
        db.exec(statement);
      }
      return db;
    } catch (err) {
      db.close();
      const code = (err as { code?: string }).code;
      if (code !== 'SQLITE_BUSY' || attempt === BOOTSTRAP_MAX_ATTEMPTS) {
        throw err;
      }
      sleepSync(BOOTSTRAP_RETRY_DELAY_MS);
    }
  }
  throw new Error('unreachable');
}

/** Owns the WAL-mode connection lifecycle; schema bootstrap runs idempotently on open. */
export class SqliteStore {
  readonly db: SqliteHandle;

  constructor(target: SqliteTarget) {
    this.db = openSqliteHandle(target);
  }

  close(): void {
    this.db.close();
  }
}
