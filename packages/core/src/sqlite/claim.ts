import { randomUUID } from 'node:crypto';
import type { SqliteHandle } from './database.js';
import type { ReflectionJob } from './reflection-queue.js';

/** A crashed or hung claimant's job becomes reclaimable after this long with no completion. */
export const DEFAULT_STALE_CLAIM_TIMEOUT_MS = 5 * 60 * 1000;

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

/**
 * Row mapping duplicated from reflection-queue.ts rather than imported: the
 * claim-two-process test loads this file directly via native ESM in a worker
 * thread, which (unlike the project's tsc/vitest resolvers) does not map a
 * relative `.js` specifier back to its sibling `.ts` source, so claim.ts cannot
 * take a runtime (non-type-only) import from reflection-queue.ts.
 */
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
 * Claims reflection_queue jobs on behalf of one process. `id` is minted once per
 * instance and stamped as `claimed_by` on every claim, so a crash-and-restart never
 * mistakes this process's fresh claims for the previous instance's stale ones.
 */
export class ReflectionQueueClaimant {
  readonly id: string;

  constructor(id: string = randomUUID()) {
    this.id = id;
  }

  /**
   * Atomically claims the oldest unclaimed job, or undefined if none. Ordered by
   * `rowid`, not `id`: ids are random UUIDs, and enqueued_at alone ties on
   * same-millisecond bursts. The UPDATE's subquery and assignment run as one SQLite
   * statement, so concurrent claimants (any process, any thread) never select the
   * same row — the file-level write lock plus busy_timeout serializes them.
   */
  claimNext(db: SqliteHandle): ReflectionJob | undefined {
    const row = db
      .prepare(
        `UPDATE reflection_queue
         SET claimed_at = ?, claimed_by = ?
         WHERE id = (
           SELECT id FROM reflection_queue
           WHERE claimed_at IS NULL
           ORDER BY rowid ASC
           LIMIT 1
         )
         RETURNING *`,
      )
      .get(new Date().toISOString(), this.id) as ReflectionJobRow | undefined;
    return row === undefined ? undefined : toReflectionJob(row);
  }

  /**
   * Returns a held job to the pool for retry: clears the claim, counts the attempt,
   * records why. Scoped to `id`, so it can only release a claim this instance holds;
   * returns false if the job isn't currently claimed by it (already released,
   * completed, or reclaimed as stale elsewhere).
   */
  release(db: SqliteHandle, jobId: string, error: string): boolean {
    const result = db
      .prepare(
        `UPDATE reflection_queue
         SET claimed_at = NULL, claimed_by = NULL, attempts = attempts + 1, last_error = ?
         WHERE id = ? AND claimed_by = ?`,
      )
      .run(error, jobId, this.id);
    return result.changes > 0;
  }

  /**
   * A held job's terminal success: the row is deleted, not marked. The queue row's
   * only purpose is retry/drain durability (PRD §4 "the queue row is durability");
   * once a job succeeds there is nothing left to retry. The durable completion
   * record for pipeline idempotency across re-runs is the ops-ledger key the
   * dispatcher writes (P3), not this table. Scoped to `id` like release; returns
   * false if this instance doesn't currently hold the claim.
   */
  complete(db: SqliteHandle, jobId: string): boolean {
    const result = db
      .prepare('DELETE FROM reflection_queue WHERE id = ? AND claimed_by = ?')
      .run(jobId, this.id);
    return result.changes > 0;
  }
}

/**
 * Startup-drain support (PRD §4): a claim older than `timeoutMs` is assumed abandoned
 * by a crashed or killed process and returned to the pool. Any claimant can reclaim
 * any other's stale claim — after a crash no live claimant remembers the dead one's
 * id, so ownership scoping (as in release/complete) would defeat the point. Attempts
 * and last_error are left untouched: a stale reclaim isn't a known failure, just an
 * interrupted one: the eventual release() or complete() records the real outcome.
 */
export function reclaimStaleReflectionJobs(
  db: SqliteHandle,
  timeoutMs: number = DEFAULT_STALE_CLAIM_TIMEOUT_MS,
  now: Date = new Date(),
): number {
  const threshold = new Date(now.getTime() - timeoutMs).toISOString();
  const result = db
    .prepare(
      `UPDATE reflection_queue
       SET claimed_at = NULL, claimed_by = NULL
       WHERE claimed_at IS NOT NULL AND claimed_at < ?`,
    )
    .run(threshold);
  return result.changes;
}
