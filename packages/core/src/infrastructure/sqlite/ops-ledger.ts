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
  const row = db.prepare('SELECT key, applied_at, summary_json FROM ops_ledger WHERE key = ?').get(
    key,
  ) as OpsLedgerRow | undefined;
  return row === undefined ? undefined : toOpsLedgerEntry(row);
}

export function isLedgerApplied(db: SqliteHandle, key: string): boolean {
  return getLedgerEntry(db, key) !== undefined;
}

/** Idempotent: re-marking the same key updates appliedAt/summary rather than erroring. */
export function markLedgerApplied(db: SqliteHandle, key: string, summary?: unknown): void {
  db.prepare(
    `INSERT INTO ops_ledger (key, applied_at, summary_json) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET applied_at = excluded.applied_at, summary_json = excluded.summary_json`,
  ).run(key, new Date().toISOString(), summary === undefined ? null : JSON.stringify(summary));
}
