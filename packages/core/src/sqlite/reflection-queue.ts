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

/** Insert only. Atomic claiming, release, and completion live in claim.ts. */
export function enqueueReflectionJob(db: SqliteHandle, jobType: string, payload: unknown): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO reflection_queue (id, job_type, payload_json, enqueued_at, attempts)
     VALUES (?, ?, ?, ?, 0)`,
  ).run(id, jobType, JSON.stringify(payload), new Date().toISOString());
  return id;
}

/**
 * The pending job whose payload carries `field = value`, for writers that must converge on
 * "exactly one job for this thing" after a crash between the durable write and the enqueue.
 * Only pending rows are visible: a completed job's row is gone (claim.ts), so absence means
 * nothing is queued, not that nothing ever ran. Re-enqueueing an already-processed job is
 * the safe direction — the pipeline's ledger key makes the re-run a no-op — while leaving a
 * missing one missing is permanent.
 */
export function findPendingReflectionJob(
  db: SqliteHandle,
  jobType: string,
  field: string,
  value: string,
): ReflectionJob | undefined {
  const row = db
    .prepare(
      `SELECT * FROM reflection_queue
       WHERE job_type = ? AND json_extract(payload_json, ?) = ?
       ORDER BY rowid ASC LIMIT 1`,
    )
    .get(jobType, `$.${field}`, value) as ReflectionJobRow | undefined;
  return row === undefined ? undefined : toReflectionJob(row);
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
