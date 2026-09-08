import { randomUUID } from 'node:crypto';

import type { SqliteHandle } from './database.js';

/**
 * The two service classes reflection work is scheduled in. `interactive` is an agent's own
 * turn, which the freshness pin requires to enrich in minutes; `bulk` is anything that can
 * wait behind it: a flagged batch import, a reconcile backfill, or a client the arrival-rate
 * backstop demoted. Claiming serves interactive strictly first, so a bulk flood can never
 * delay an interactive episode by more than the job already running.
 *
 * `database.ts` and `claim.ts` carry these strings as SQL literals: a column default, and the
 * ordering claiming reads. Reading one back is `toReflectionLane` below, which claim.ts calls
 * rather than testing the names a second time.
 */
export const REFLECTION_LANES = ['interactive', 'bulk'] as const;

export type ReflectionLane = (typeof REFLECTION_LANES)[number];

export const DEFAULT_REFLECTION_LANE: ReflectionLane = 'interactive';

/** The payload field a source-keyed job carried before it had a column of its own. */
export const REFLECTION_QUEUE_EPISODE_FIELD = 'episode_id';

export function isReflectionLane(value: unknown): value is ReflectionLane {
  return REFLECTION_LANES.includes(value as ReflectionLane);
}

export type ReflectionJob = {
  id: string;
  jobType: string;
  payload: unknown;
  enqueuedAt: string;
  attempts: number;
  claimedAt: string | null;
  claimedBy: string | null;
  lastError: string | null;
  lane: ReflectionLane;
  /** Absent on a row enqueued before the column existed; such a row is its own round-robin group. */
  sessionId: string | null;
};

export type ReflectionJobRow = {
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
};

/** A lane written before this column existed, or by a future version, reads as the default. */
export function toReflectionLane(value: unknown): ReflectionLane {
  return isReflectionLane(value) ? value : DEFAULT_REFLECTION_LANE;
}

export function toReflectionJob(row: ReflectionJobRow): ReflectionJob {
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
  };
}

export type EnqueueReflectionJobOptions = {
  readonly lane?: ReflectionLane;
  /**
   * The source this job is about, stored in its own column. Every writer that enqueues work
   * keyed on a source passes it, which is what lets the duplicate-job lookup read a column
   * instead of decoding every payload in the queue.
   */
  readonly episodeId?: string;
  /** The graph Session the job's episode belongs to; what round-robin claiming groups by. */
  readonly sessionId?: string;
  /**
   * The moment stamped on the row. A queue row is a system-time record, so this is the wall
   * clock. Intake passes its own archive stamp, so an episode's archive row and its queue row
   * agree exactly. A caller with no clock in scope, such as `reconcile`'s backfill, omits it
   * and the row stamps at enqueue.
   */
  readonly now?: Date;
};

/**
 * Insert only. Atomic claiming, release, and completion live in claim.ts.
 *
 * `lane_seq` is this row's turn within its own (lane, session) group, taken from the group's
 * current high-water mark. Claiming orders by it, so the groups interleave: every session's
 * first queued job, then every session's second, and so on. Stamping it here rather than
 * computing it at claim time is what makes the interleave survive draining. A window
 * function over the unclaimed rows renumbers every group the moment one row leaves it.
 *
 * The mark is over queued rows only, so a session whose backlog has drained starts at 1
 * again and competes with every other session's next job, while a session that is still
 * thousands deep keeps counting up. That is the fairness this exists for.
 */
export function enqueueReflectionJob(
  db: SqliteHandle,
  jobType: string,
  payload: unknown,
  options: EnqueueReflectionJobOptions = {},
): string {
  const id = randomUUID();
  const lane = options.lane ?? DEFAULT_REFLECTION_LANE;
  const sessionId = options.sessionId ?? null;
  const enqueuedAt = options.now ?? new Date();
  db.prepare(
    `INSERT INTO reflection_queue
       (id, job_type, payload_json, enqueued_at, attempts, lane, session_id, episode_id, lane_seq)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?, (
       SELECT COALESCE(MAX(lane_seq), 0) + 1 FROM reflection_queue
       WHERE lane = ? AND session_id IS ?
     ))`,
  ).run(
    id,
    jobType,
    JSON.stringify(payload),
    enqueuedAt.toISOString(),
    lane,
    sessionId,
    options.episodeId ?? null,
    lane,
    sessionId,
  );
  return id;
}

/**
 * Rows enqueued before the column existed, which is what the compatibility lookup below is
 * for. A pending row is the only kind that matters: a claimed-and-completed job's row is gone,
 * so a null on a row nobody can claim any more decides nothing.
 */
export function legacyEpisodeQueueRows(db: SqliteHandle): number {
  const row = db
    .prepare('SELECT count(*) AS n FROM reflection_queue WHERE episode_id IS NULL')
    .get() as { n: number };
  return row.n;
}

/**
 * Fills the column on rows written before it existed, reading each payload once. Returns how
 * many rows moved, so a repeat returns zero and the caller can tell a finished backfill from
 * one that has more to do.
 *
 * A row whose payload names no episode is left alone rather than given an empty string: it is
 * not an integrate job, and inventing a key for it would make the lookup below answer for
 * something nobody enqueued.
 */
export function backfillReflectionQueueEpisodeIds(db: SqliteHandle): number {
  const path = `$.${REFLECTION_QUEUE_EPISODE_FIELD}`;
  return db
    .prepare(
      `UPDATE reflection_queue SET episode_id = json_extract(payload_json, ?)
       WHERE episode_id IS NULL AND json_extract(payload_json, ?) IS NOT NULL`,
    )
    .run(path, path).changes;
}

/**
 * The pending job whose payload carries `field = value`, for writers that must converge on
 * "exactly one job for this thing" after a crash between the durable write and the enqueue.
 * Only pending rows are visible: a completed job's row is gone (claim.ts), so absence means
 * nothing is queued, not that nothing ever ran. Re-enqueueing an already-processed job is
 * the safe direction (the pipeline's ledger key makes the re-run a no-op), while leaving a
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

/**
 * The pending job for one source, read off the column, with the old payload scan still guarding
 * duplicates while any row predates the column.
 *
 * The compatibility read is what keeps the transition safe in both directions: a legacy row
 * carries no column value, so the column lookup alone would miss it and queue a second job for
 * work already pending. It runs only while such a row exists, and the scan disappears on its own
 * once the backfill has accounted for every one of them.
 */
export function findPendingJobForEpisode(
  db: SqliteHandle,
  jobType: string,
  episodeId: string,
): ReflectionJob | undefined {
  const row = db
    .prepare(
      `SELECT * FROM reflection_queue
       WHERE job_type = ? AND episode_id = ?
       ORDER BY rowid ASC LIMIT 1`,
    )
    .get(jobType, episodeId) as ReflectionJobRow | undefined;
  if (row !== undefined) {
    return toReflectionJob(row);
  }
  if (legacyEpisodeQueueRows(db) === 0) {
    return undefined;
  }
  return findPendingReflectionJob(db, jobType, REFLECTION_QUEUE_EPISODE_FIELD, episodeId);
}

export function getReflectionJob(db: SqliteHandle, id: string): ReflectionJob | undefined {
  const row = db.prepare('SELECT * FROM reflection_queue WHERE id = ?').get(id) as
    ReflectionJobRow | undefined;
  return row === undefined ? undefined : toReflectionJob(row);
}

/** Ordered by insertion (rowid), not enqueued_at: same-millisecond bursts would tie on the latter. */
export function listReflectionJobs(db: SqliteHandle): ReflectionJob[] {
  const rows = db
    .prepare('SELECT * FROM reflection_queue ORDER BY rowid ASC')
    .all() as ReflectionJobRow[];
  return rows.map(toReflectionJob);
}
