import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { migrateUnversionedLedgerKeys } from './ledger-version-migration.js';

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
  /**
   * `burst_id` names the set of rows one producer wrote in one go. Two producers stamping the
   * same trigger in the same millisecond are otherwise indistinguishable, and the flush would
   * read them as one larger clique and over-discount both. Null on a row written before the
   * column existed, where the trigger and the timestamp are all there is to group by.
   */
  `CREATE TABLE IF NOT EXISTS reinforcement_queue (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    trigger TEXT NOT NULL,
    ts TEXT NOT NULL,
    burst_id TEXT
  )`,
  /**
   * Every affirmative contradiction judgment from reflection's supersession stage. `aion why`
   * surfaces the open rows and a person applies them, and the stage applies them itself under
   * `AION_SUPERSEDE_MODE=unanimous`. `UNIQUE (old_id, new_id)` is what makes a re-judged pair
   * one row rather than a growing pile.
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
   * told again rather than treated as known. `last_served_at` is what every read and the idle
   * purge use. `first_served_at` is written once and never rewritten or selected: it is kept so
   * a later forensic read can say when a session first learned a memory.
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
  /**
   * One row per reflection payload intake ever stored, independent of what the graph does
   * with it afterward. A replay reads this table to re-run the pipeline against the same
   * content without a caller pushing it again, and a debug view reads it to show when a
   * payload arrived against when the graph enriched it.
   *
   * `idempotency_key` folds `identity` back in rather than keying on `content_hash` alone:
   * episode dedup is scoped to one session, so two sessions pushing identical content are two
   * episodes, and a content-only key would collapse their archive rows into one.
   *
   * `occurred_at` is the episode's own clock, the earliest timestamp found in its content.
   * `archived_at` is the wall clock at write time and the only wall-clock value on the row.
   * There is no `UPDATE` and no `DELETE` anywhere this table is written: insert conflicts on
   * `idempotency_key` are a no-op, so a re-pushed payload never rewrites the row that first
   * recorded it.
   */
  `CREATE TABLE IF NOT EXISTS experience_archive (
    id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    schema_version INTEGER NOT NULL,
    pipeline_version TEXT NOT NULL,
    identity TEXT NOT NULL,
    session_id TEXT NOT NULL,
    episode_id TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    archived_at TEXT NOT NULL,
    lane TEXT,
    origin_json TEXT,
    payload_json TEXT NOT NULL
  )`,
];

/**
 * Indexes, declared after the tables and applied after `COLUMN_ADDITIONS`. A retrofitted
 * substrate does not have the added columns until that pass runs, and an index over one of them
 * fails outright on a table that predates it.
 */
const INDEX_STATEMENTS: readonly string[] = [
  // The claim's whole ORDER BY, so a claim seeks the first unclaimed row instead of sorting
  // every pending one. The lane CASE is indexed as the expression the statement writes, since
  // an index on `lane` alone sorts bulk ahead of interactive.
  `CREATE INDEX IF NOT EXISTS reflection_queue_claim_idx
     ON reflection_queue (CASE lane WHEN 'interactive' THEN 0 ELSE 1 END, lane_seq, attempts, id)
     WHERE claimed_at IS NULL`,
  // The high-water read every enqueue makes to stamp `lane_seq` for its (lane, session) group.
  `CREATE INDEX IF NOT EXISTS reflection_queue_lane_seq_idx
     ON reflection_queue (lane, session_id, lane_seq)`,
  // The right arm of the node lookup. `UNIQUE (old_id, new_id)` already covers the left one as
  // a prefix, and SQLite applies its OR optimization only when both arms can seek.
  `CREATE INDEX IF NOT EXISTS supersession_proposals_new_idx
     ON supersession_proposals (new_id)`,
  // The right arm of the node lookup. `UNIQUE (left_id, right_id)` already covers the left one
  // as a prefix, and SQLite applies its OR optimization only when both arms can seek.
  `CREATE INDEX IF NOT EXISTS entity_merge_proposals_right_idx
     ON entity_merge_proposals (right_id)`,
  // A replay walks rows oldest first by keyset, never OFFSET, so its cursor survives an abort.
  `CREATE INDEX IF NOT EXISTS experience_archive_replay_idx
     ON experience_archive (occurred_at, id)`,
  `CREATE INDEX IF NOT EXISTS experience_archive_episode_idx
     ON experience_archive (episode_id)`,
  `CREATE INDEX IF NOT EXISTS experience_archive_version_idx
     ON experience_archive (pipeline_version)`,
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
  { table: 'reinforcement_queue', column: 'burst_id', definition: 'TEXT' },
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
      for (const statement of INDEX_STATEMENTS) {
        db.exec(statement);
      }
      // Runs on every open so every entrypoint gets it, and does nothing once a substrate has
      // been through it.
      migrateUnversionedLedgerKeys(db);
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
