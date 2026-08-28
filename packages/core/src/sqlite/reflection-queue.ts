import { randomUUID } from 'node:crypto';
import type { SqliteHandle } from './database.js';

export type ReflectionJob = {
  id: string;
  jobType: string;
  payload: unknown;
  enqueuedAt: string;
  attempts: number;
  claimedAt: string | null;
  claimedBy: string | null;
  lastError: string | null;
};

type ReflectionJobRow = {
  id: string;
  job_type: string;
  payload_json: string;
  enqueued_at: string;
  attempts: number;
  claimed_at: string | null;
  claimed_by: string | null;
  last_error: string | null;
};

function toReflectionJob(row: ReflectionJobRow): ReflectionJob {
  return {
    id: row.id,
    jobType: row.job_type,
    payload: JSON.parse(row.payload_json) as unknown,
    enqueuedAt: row.enqueued_at,
    attempts: row.attempts,
    claimedAt: row.claimed_at,
    claimedBy: row.claimed_by,
    lastError: row.last_error,
  };
}

/**
 * Insert only. Atomic claiming (UPDATE ... RETURNING, per-process claimant id, stale-
 * claim recovery) arrives with the dispatcher and builds on this table.
 */
export function enqueueReflectionJob(db: SqliteHandle, jobType: string, payload: unknown): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO reflection_queue (id, job_type, payload_json, enqueued_at, attempts)
     VALUES (?, ?, ?, ?, 0)`,
  ).run(id, jobType, JSON.stringify(payload), new Date().toISOString());
  return id;
}

export function getReflectionJob(db: SqliteHandle, id: string): ReflectionJob | undefined {
  const row = db.prepare('SELECT * FROM reflection_queue WHERE id = ?').get(id) as
    | ReflectionJobRow
    | undefined;
  return row === undefined ? undefined : toReflectionJob(row);
}

/** Ordered by insertion (rowid), not enqueued_at: same-millisecond bursts would tie on the latter. */
export function listReflectionJobs(db: SqliteHandle): ReflectionJob[] {
  const rows = db.prepare('SELECT * FROM reflection_queue ORDER BY rowid ASC').all() as ReflectionJobRow[];
  return rows.map(toReflectionJob);
}
