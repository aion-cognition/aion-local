import type { SqliteHandle } from './database.js';

/**
 * The dead-letter half of `reflection_queue` admin: rows the claim path will never take
 * again (`attempts >= maxAttempts`, still unclaimed). `reflection-queue-admin.ts` covers
 * the operator's read/drop/promote surface; this file is narrower, built for the
 * introspector's `dead_letter` operation, which gives an exhausted row exactly one more
 * try and then leaves it alone.
 *
 * The queue table carries no column for "already given its one retry", so that state lives
 * in `ops_ledger` under `DEAD_LETTER_SEEN_LEDGER_PREFIX`, keyed by job id rather than by
 * time bucket. A row that fails again after being re-laned keeps that marker forever, which
 * is what turns a second exhaustion into "needs a person" instead of another automatic
 * retry.
 */

export const DEAD_LETTER_SEEN_LEDGER_PREFIX = 'intro:dead_letter:seen:';

export function deadLetterSeenKey(jobId: string): string {
  return `${DEAD_LETTER_SEEN_LEDGER_PREFIX}${jobId}`;
}

export type ExhaustedJob = {
  readonly id: string;
  readonly jobType: string;
  readonly enqueuedAt: string;
};

/**
 * Oldest first: a row that has waited longest for attention waits longest for the retry too.
 *
 * Rows already carrying the seen marker are excluded in SQL rather than skipped by the caller.
 * A row that spent its one retry keeps its original `enqueued_at`, so it sorts ahead of every
 * newly exhausted row forever; filtering after the fact would let a batch's worth of permanently
 * stuck rows fill the batch and starve the rows that still have a retry coming.
 */
export function listExhaustedJobs(
  db: SqliteHandle,
  maxAttempts: number,
  limit: number,
): ExhaustedJob[] {
  const rows = db
    .prepare(
      `SELECT id, job_type, enqueued_at FROM reflection_queue
       WHERE claimed_at IS NULL AND attempts >= ?
         AND NOT EXISTS (SELECT 1 FROM ops_ledger WHERE key = ? || reflection_queue.id)
       ORDER BY enqueued_at ASC, rowid ASC
       LIMIT ?`,
    )
    .all(maxAttempts, DEAD_LETTER_SEEN_LEDGER_PREFIX, limit) as {
    id: string;
    job_type: string;
    enqueued_at: string;
  }[];
  return rows.map((row) => ({ id: row.id, jobType: row.job_type, enqueuedAt: row.enqueued_at }));
}

/**
 * Moves the job to the bulk lane and resets its attempt count, so the claim path can take
 * it again. Scoped to still-unclaimed rows: a row a worker picked up between the list and
 * this call is no longer this operation's to touch. Returns whether the row actually moved.
 *
 * `lane_seq` is restamped from the bulk group the row lands in, because the column numbers a
 * row within its own (lane, session) group. A retry that kept its old turn would sort ahead of
 * bulk work that has been waiting longer than it has.
 */
export function relaneDeadLetterJob(db: SqliteHandle, jobId: string): boolean {
  const result = db
    .prepare(
      `UPDATE reflection_queue
         SET lane = 'bulk',
             attempts = 0,
             lane_seq = (
               SELECT COALESCE(MAX(q.lane_seq), 0) + 1 FROM reflection_queue q
               WHERE q.lane = 'bulk' AND q.session_id IS reflection_queue.session_id
             )
       WHERE id = ? AND claimed_at IS NULL`,
    )
    .run(jobId);
  return result.changes > 0;
}

/**
 * Exhausted rows the operation has already given their one retry to, and that failed again.
 * These are what `dead_letter` stops touching and the substrate should surface instead of
 * silently dropping; `application/observe.ts` reads this into `QueueHealth`.
 */
export function countDeadLetterAttention(db: SqliteHandle, maxAttempts: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM reflection_queue q
       WHERE q.claimed_at IS NULL AND q.attempts >= ?
         AND EXISTS (SELECT 1 FROM ops_ledger WHERE key = ? || q.id)`,
    )
    .get(maxAttempts, DEAD_LETTER_SEEN_LEDGER_PREFIX) as { n: number };
  return row.n;
}
