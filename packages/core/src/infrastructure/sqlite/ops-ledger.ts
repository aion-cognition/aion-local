import type { SqliteHandle } from './database.js';

export type OpsLedgerEntry = {
  key: string;
  appliedAt: string;
  summary: unknown;
};

type OpsLedgerRow = {
  key: string;
  applied_at: string;
  summary_json: string | null;
};

function toOpsLedgerEntry(row: OpsLedgerRow): OpsLedgerEntry {
  return {
    key: row.key,
    appliedAt: row.applied_at,
    summary: row.summary_json === null ? undefined : (JSON.parse(row.summary_json) as unknown),
  };
}

export function getLedgerEntry(db: SqliteHandle, key: string): OpsLedgerEntry | undefined {
  const row = db
    .prepare('SELECT key, applied_at, summary_json FROM ops_ledger WHERE key = ?')
    .get(key) as OpsLedgerRow | undefined;
  return row === undefined ? undefined : toOpsLedgerEntry(row);
}

export function isLedgerApplied(db: SqliteHandle, key: string): boolean {
  return getLedgerEntry(db, key) !== undefined;
}

/**
 * Every key under one namespace, for callers that must answer "which of these thousands of
 * things has run" without a query per thing. `prefix` is matched with LIKE against a literal
 * escape, so a key containing `%` or `_` cannot widen the match.
 */
export function listLedgerKeys(db: SqliteHandle, prefix: string): string[] {
  const escaped = prefix.replace(/[\\%_]/g, '\\$&');
  const rows = db
    .prepare("SELECT key FROM ops_ledger WHERE key LIKE ? ESCAPE '\\' ORDER BY key")
    .all(`${escaped}%`) as { key: string }[];
  return rows.map((row) => row.key);
}

/**
 * Every entry under one namespace, keyed and summarized. `listLedgerKeys` above answers which
 * of many things has run; this is for a caller that also needs what each one recorded, such as
 * comparing a batch of stored verdicts against a live reading one at a time.
 */
export function listLedgerEntries(db: SqliteHandle, prefix: string): OpsLedgerEntry[] {
  const escaped = prefix.replace(/[\\%_]/g, '\\$&');
  const rows = db
    .prepare(
      "SELECT key, applied_at, summary_json FROM ops_ledger WHERE key LIKE ? ESCAPE '\\' ORDER BY key",
    )
    .all(`${escaped}%`) as OpsLedgerRow[];
  return rows.map(toOpsLedgerEntry);
}

/**
 * The newest entry under a namespace. For a time-bucketed key that is the last window the
 * operation ran in, which is what an operator asking "did maintenance do anything" wants.
 * Ordered by write time first, so an operation whose bucket granularity changed still reports
 * its most recent run rather than the last key that happens to sort highest.
 */
export function latestLedgerEntry(db: SqliteHandle, prefix: string): OpsLedgerEntry | undefined {
  const escaped = prefix.replace(/[\\%_]/g, '\\$&');
  const row = db
    .prepare(
      `SELECT key, applied_at, summary_json FROM ops_ledger WHERE key LIKE ? ESCAPE '\\'
       ORDER BY applied_at DESC, key DESC LIMIT 1`,
    )
    .get(`${escaped}%`) as OpsLedgerRow | undefined;
  return row === undefined ? undefined : toOpsLedgerEntry(row);
}

/**
 * There is no delete here, on purpose. A ledger row is the record that something ran, and the two
 * writers that hold a position in one clear the position rather than removing the row: a cleared
 * candidate cursor is one row per family that ever needed one, and the un-versioned key a key
 * migration leaves behind is one row per migrated family. Both populations are bounded by families
 * rather than by anything that grows with use, and both carry an empty summary. Exporting a delete
 * would let a caller destroy the record of a run to reclaim rows that were never the cost.
 */

/** Idempotent: re-marking the same key updates appliedAt/summary rather than erroring. */
export function markLedgerApplied(db: SqliteHandle, key: string, summary?: unknown): void {
  db.prepare(
    `INSERT INTO ops_ledger (key, applied_at, summary_json) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET applied_at = excluded.applied_at, summary_json = excluded.summary_json`,
  ).run(key, new Date().toISOString(), summary === undefined ? null : JSON.stringify(summary));
}
