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
   * What each session has already been handed, one row per (session, item). `last_pack` cannot
   * answer this: it keeps only the newest pack, and the conversation holds every pack the
   * session was ever served.
   *
   * `fingerprint` is what the item said when it was served, so a memory that changed since is
   * told again rather than treated as known. `first_served_at` is never rewritten; a re-serve
   * moves `last_served_at` only, which is what the session's rows are aged against.
   */
  `CREATE TABLE IF NOT EXISTS served_items (
    session_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    first_served_at TEXT NOT NULL,
    last_served_at TEXT NOT NULL,
    PRIMARY KEY (session_id, item_id)
  )`,
  /**
   * The cascade's residue: pairs the two judge passes split on, which is the one case left for
   * a person. Its own table rather than a `kind` column on `supersession_proposals` because the
   * columns do not overlap: no contradiction judgment, no model confidence, and a pair of names
   * and types the reviewer has to see to decide. The pair is stored id-sorted, so discovery
   * from either side is one row.
   *
   * `similarity` needs `similarity_source` beside it to mean anything. A vector nomination
   * stores a cosine and a graph nomination stores a shared-episode Jaccard; the two are not on
   * one scale, and a column read as a cosine that sometimes holds a set-overlap ratio is worse
   * than no number at all.
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
    similarity_source TEXT NOT NULL DEFAULT 'name_cosine',
    episode_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    UNIQUE (left_id, right_id)
  )`,
  /**
   * What the dedup cascade knew when it merged. One row per merge, whichever tier decided it,
   * so the unmerge operation can cite the evidence that was wrong and a prompt change can be
   * replayed against past decisions rather than against a graph that has moved on.
   *
   * There is no confidence column by doctrine: model certainty is not a quantity anything may
   * threshold on, and the surest way to stop a later caller reading one is for there to be
   * nothing to read. `reasons`, the measured `signals`, and the judge's two booleans with the
   * prose behind them are what a decision is made of.
   *
   * `idempotency_key` is sha256 over the canonical, the sorted members and the cascade version.
   * A replay of the same merge refreshes one row; a merge re-decided under a new cascade version
   * writes its own record beside the old one rather than erasing what the old prompts said.
   */
  `CREATE TABLE IF NOT EXISTS entity_merge_decisions (
    id TEXT PRIMARY KEY,
    canonical_id TEXT NOT NULL,
    member_ids TEXT NOT NULL,
    tier TEXT NOT NULL,
    reasons TEXT NOT NULL,
    signals TEXT NOT NULL,
    judge_verdicts TEXT,
    cascade_version TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  )`,
  // The canonical arm of the decision lookup. The member arm walks the stored JSON list, which
  // no index covers; at one row per merge that scan is cheaper than a second table to join.
  `CREATE INDEX IF NOT EXISTS entity_merge_decisions_canonical_idx
     ON entity_merge_decisions (canonical_id)`,
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
  {
    table: 'entity_merge_proposals',
    column: 'similarity_source',
    definition: "TEXT NOT NULL DEFAULT 'name_cosine'",
  },
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
