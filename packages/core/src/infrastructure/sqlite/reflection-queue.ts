import { randomUUID } from 'node:crypto';
import type { SqliteHandle } from './database.js';

/**
 * The two service classes reflection work is scheduled in. `interactive` is an agent's own
 * turn, which the freshness pin requires to enrich in minutes; `bulk` is anything that can
 * wait behind it: a flagged batch import, a reconcile backfill, or a client the arrival-rate
 * backstop demoted. Claiming serves interactive strictly first, so a bulk flood can never
 * delay an interactive episode by more than the job already running.
 *
 * `database.ts` and `claim.ts` carry these strings as SQL literals rather than importing
 * them: both are loaded by the forked claim fixture through native ESM, which does not map a
 * `.js` specifier back to its `.ts` sibling.
 */
export const REFLECTION_LANES = ['interactive', 'bulk'] as const;

export type ReflectionLane = (typeof REFLECTION_LANES)[number];

export const DEFAULT_REFLECTION_LANE: ReflectionLane = 'interactive';

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
  /** The graph Session the job's episode belongs to; what round-robin claiming groups by. */
  readonly sessionId?: string;
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
  db.prepare(
    `INSERT INTO reflection_queue
       (id, job_type, payload_json, enqueued_at, attempts, lane, session_id, lane_seq)
     VALUES (?, ?, ?, ?, 0, ?, ?, (
       SELECT COALESCE(MAX(lane_seq), 0) + 1 FROM reflection_queue
       WHERE lane = ? AND session_id IS ?
     ))`,
  ).run(id, jobType, JSON.stringify(payload), new Date().toISOString(), lane, sessionId, lane, sessionId);
  return id;
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
