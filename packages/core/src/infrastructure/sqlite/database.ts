import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Name for the config registry, which is the only place the variable is read. */
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
  /**
   * `lane`, `session_id` and `lane_seq` are what claiming orders by: interactive before bulk,
   * and round-robin across sessions inside a lane. They are columns rather than payload fields
   * so the claim's ORDER BY and the operator's filters read them without decoding JSON per
   * row, at the queue depths (thousands) where that decides whether triage is possible.
   *
   * `lane_seq` is the row's position in its own (lane, session) group, stamped at insert
   * (see reflection-queue.ts). It cannot be computed at claim time: a window function over the
   * unclaimed rows renumbers every group as rows leave, which collapses the interleave back
   * into first-in-first-out after the first claim.
   */
  `CREATE TABLE IF NOT EXISTS reflection_queue (
    id TEXT PRIMARY KEY,
    job_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    enqueued_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    claimed_at TEXT,
    claimed_by TEXT,
    last_error TEXT,
    lane TEXT NOT NULL DEFAULT 'interactive',
    session_id TEXT,
    lane_seq INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS reinforcement_queue (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    trigger TEXT NOT NULL,
    ts TEXT NOT NULL
  )`,
  /**
   * Sub-threshold contradiction judgments from reflection's supersession stage. They are
   * never applied: `aion why` surfaces them and a person decides. `UNIQUE (old_id, new_id)`
   * is what makes a re-judged pair one row rather than a growing pile.
   */
  `CREATE TABLE IF NOT EXISTS supersession_proposals (
    id TEXT PRIMARY KEY,
    old_id TEXT NOT NULL,
    new_id TEXT NOT NULL,
    confidence REAL NOT NULL,
    rationale TEXT,
    episode_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    UNIQUE (old_id, new_id)
  )`,
  `CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS last_pack (
    session_id TEXT PRIMARY KEY,
    pack_json TEXT NOT NULL,
    ts TEXT NOT NULL,
    as_of TEXT,
    knew_at TEXT
  )`,
  /**
   * Near-duplicate entities of different types, which dedup detects and never applies: one
   * real thing typed two ways is a type mistake, and merging on the type key would pick a
   * winner the extraction never justified. Its own table rather than a `kind` column on
   * `supersession_proposals` because the columns do not overlap: no contradiction judgment,
   * no model confidence, and a pair of names and types the reviewer has to see to decide.
   * The pair is stored id-sorted, so discovery from either side is one row.
   */
  `CREATE TABLE IF NOT EXISTS entity_merge_proposals (
    id TEXT PRIMARY KEY,
    left_id TEXT NOT NULL,
    left_name TEXT NOT NULL,
    left_type TEXT NOT NULL,
    right_id TEXT NOT NULL,
    right_name TEXT NOT NULL,
    right_type TEXT NOT NULL,
    similarity REAL NOT NULL,
    episode_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    UNIQUE (left_id, right_id)
  )`,
];

type ColumnAddition = {
  readonly table: string;
  readonly column: string;
  readonly definition: string;
};

/**
 * Columns added to a table that already shipped. SQLite has no `ADD COLUMN IF NOT EXISTS`,
 * and a second ALTER raises "duplicate column name", so the shape is read first: this runs
 * on every open of every existing substrate. The literals match the CREATE above, which is
 * what makes a fresh file and a retrofitted one the same table.
 */
const COLUMN_ADDITIONS: readonly ColumnAddition[] = [
  { table: 'reflection_queue', column: 'lane', definition: "TEXT NOT NULL DEFAULT 'interactive'" },
  { table: 'reflection_queue', column: 'session_id', definition: 'TEXT' },
  { table: 'reflection_queue', column: 'lane_seq', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'last_pack', column: 'as_of', definition: 'TEXT' },
  { table: 'last_pack', column: 'knew_at', definition: 'TEXT' },
];

function tableColumns(db: SqliteHandle, table: string): ReadonlySet<string> {
  const rows = db.pragma(`table_info(${table})`) as { name: string }[];
  return new Set(rows.map((row) => row.name));
}

function applyColumnAdditions(db: SqliteHandle): void {
  for (const addition of COLUMN_ADDITIONS) {
    if (tableColumns(db, addition.table).has(addition.column)) {
      continue;
    }
    db.exec(`ALTER TABLE ${addition.table} ADD COLUMN ${addition.column} ${addition.definition}`);
  }
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
 * this path; verified with two connections racing a fresh file in test.
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
      applyColumnAdditions(db);
      return db;
    } catch (err) {
      db.close();
      const { code } = err as { code?: string };
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
