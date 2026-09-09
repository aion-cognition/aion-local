import { randomUUID } from 'node:crypto';

import type { SqliteHandle } from './database.js';
import { toReflectionLane, type ReflectionJob } from './reflection-queue.js';

type ReflectionJobRow = {
  id: string;
  job_type: string;
  payload_json: string;
  enqueued_at: string;
  attempts: number;
  claimed_at: string | null;
  claimed_by: string | null;
  last_error: string | null;
  lane: string | null;
  session_id: string | null;
  episode_id: string | null;
};

/**
 * Row mapping duplicated from reflection-queue.ts, whose lane conversion this one calls: a
 * second list of the lane names would let a third lane reach one of them and not the other.
 *
 * The claim-two-process test loads this file directly via native ESM in a forked child
 * process, where a relative `.js` specifier resolves only through
 * ts-specifier-hook.fixture.ts, so an import added here has to name a real sibling source.
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
    lane: toReflectionLane(row.lane),
    sessionId: row.session_id,
    episodeId: row.episode_id,
  };
}

/**
 * Which claimable row goes next, as one ordered subquery.
 *
 * The lane CASE sorts first, 0 for interactive and 1 for everything else, so no bulk
 * row is ever claimed while an interactive one is claimable. That is the starvation the live
 * incident produced (4,016 bulk jobs ahead of every real episode); it cannot recur in that
 * direction. An unrecognised lane sorts with bulk: a lane nobody named yet is not a
 * promotion.
 *
 * `lane_seq` is the row's turn within its own (lane, session) group, stamped at insert
 * (reflection-queue.ts), so ordering by it interleaves the sessions: every session's first
 * job, then every session's second, and so on. One session pushing a thousand episodes
 * therefore delays another session's first episode by one job, not by a thousand. `rowid`
 * breaks the remaining tie, which makes the order among equal turns first-in-first-out and
 * the whole ordering total.
 *
 * The turn is a stored column and not a window function over this result set for a reason:
 * ROW_NUMBER would renumber every group as rows are claimed, so after the first claim the
 * interleave collapses back into first-in-first-out.
 */
function claimNextStatement(typeCount: number, excludeCount: number): string {
  const typeClause =
    typeCount === 0 ? '' : `AND job_type IN (${new Array(typeCount).fill('?').join(', ')})`;
  // Excluded inside the same ordered subquery rather than after the claim: a claimant that took
  // the row and then put it back would spend one of that row's attempts on a decision it had
  // already made.
  const excludeClause =
    excludeCount === 0 ? '' : `AND id NOT IN (${new Array(excludeCount).fill('?').join(', ')})`;
  return `UPDATE reflection_queue
         SET claimed_at = ?, claimed_by = ?
         WHERE id = (
           SELECT id FROM reflection_queue
           WHERE claimed_at IS NULL AND attempts < ? ${typeClause} ${excludeClause}
           ORDER BY CASE lane WHEN 'interactive' THEN 0 ELSE 1 END, lane_seq, rowid
           LIMIT 1
         )
         RETURNING *`;
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
   * Atomically claims the next unclaimed job by the lane-then-round-robin order documented
   * on `CLAIM_NEXT` above, or undefined if none. Insertion order (`rowid`) rather than `id`
   * or `enqueued_at` is what breaks every tie in it: ids are random UUIDs and enqueued_at
   * ties on same-millisecond bursts. The UPDATE's subquery and assignment run as one SQLite
   * statement, so concurrent claimants (any process, any thread) never select the
   * same row: the file-level write lock plus busy_timeout serializes them.
   *
   * `maxAttempts` bounds retrying: a row that has already failed that many times is
   * left in the queue with its last error and never claimed again. Skipping it here,
   * rather than in the caller, is what keeps the selection atomic. A claimant that
   * claimed the row first and then declined it would have to release it, and release
   * counts another attempt.
   *
   * `jobTypes` narrows the claim to work this caller can actually run. The table carries more
   * than one kind of job now, and a claimant that took a row it has no runner for would spend
   * that row's attempts failing it rather than leaving it for the process that owns it.
   * Omitting the list claims any type, which is what an operator draining the queue wants.
   *
   * `excludeIds` are rows this caller is deliberately leaving alone — work it released itself and
   * owes a wait before touching again. The exclusion belongs in the selection because a released
   * row is claimable the instant it is released: without it, the caller's own next pass reclaims
   * exactly the row whose backoff it just started.
   */
  claimNext(
    db: SqliteHandle,
    maxAttempts?: number,
    jobTypes: readonly string[] = [],
    excludeIds: readonly string[] = [],
  ): ReflectionJob | undefined {
    const attemptBound = maxAttempts ?? Number.MAX_SAFE_INTEGER;
    const row = db
      .prepare(claimNextStatement(jobTypes.length, excludeIds.length))
      .get(new Date().toISOString(), this.id, attemptBound, ...jobTypes, ...excludeIds) as
      ReflectionJobRow | undefined;
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
   * only purpose is retry and drain durability; once a job succeeds there is nothing
   * left to retry. The durable completion record for pipeline idempotency across
   * re-runs is the ops-ledger key the dispatcher writes, not this table. Scoped to
   * `id` like release; returns false if this instance doesn't currently hold the
   * claim.
   */
  complete(db: SqliteHandle, jobId: string): boolean {
    const result = db
      .prepare('DELETE FROM reflection_queue WHERE id = ? AND claimed_by = ?')
      .run(jobId, this.id);
    return result.changes > 0;
  }
}

/**
 * Startup-drain support: a claim older than `timeoutMs` is assumed abandoned by a
 * crashed or killed process and returned to the pool. Any claimant can reclaim any
 * other's stale claim: after a crash no live claimant remembers the dead one's id, so
 * ownership scoping (as in release/complete) would defeat the point. Attempts and
 * last_error are left untouched: a stale reclaim isn't a known failure, just an
 * interrupted one; the eventual release() or complete() records the real outcome.
 *
 * `exceptClaimant` is for a live caller sweeping on a timer rather than at startup: it is
 * still holding claims of its own, for a run in flight or a retry parked on a backoff, and
 * taking those back from itself would run the same episode twice concurrently.
 *
 * `timeoutMs` is required: the window is an operator knob
 * (`AION_WORKER_STALE_CLAIM_TIMEOUT_MS`), and a default here would be a second declaration of
 * it that the service never reads and nothing keeps in step.
 */
export function reclaimStaleReflectionJobs(
  db: SqliteHandle,
  timeoutMs: number,
  now: Date = new Date(),
  exceptClaimant?: string,
): number {
  const threshold = new Date(now.getTime() - timeoutMs).toISOString();
  const ownership = exceptClaimant === undefined ? '' : ' AND claimed_by IS NOT ?';
  const statement = db.prepare(
    `UPDATE reflection_queue
       SET claimed_at = NULL, claimed_by = NULL
       WHERE claimed_at IS NOT NULL AND claimed_at < ?${ownership}`,
  );
  const result =
    exceptClaimant === undefined
      ? statement.run(threshold)
      : statement.run(threshold, exceptClaimant);
  return result.changes;
}
