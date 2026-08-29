import type { SqliteHandle } from './database.js';
import {
  DEFAULT_REFLECTION_LANE,
  toReflectionJob,
  type ReflectionJob,
  type ReflectionJobRow,
  type ReflectionLane,
} from './reflection-queue.js';

/**
 * The operator's view of `reflection_queue`. The live incident was triaged with hand-written
 * SQL inside the container because nothing here existed; every statement below is one of the
 * ones that had to be typed by hand that night.
 *
 * Reads are unrestricted. Writes only ever touch unclaimed rows: a claimed row belongs to a
 * worker that is running it right now, and deleting it under that worker would strand the
 * episode with no queue row and no ledger key, which is exactly the state `reconcile` exists
 * to repair.
 */

export type ReflectionQueueFilter = {
  readonly sessionId?: string;
  readonly lane?: ReflectionLane;
};

export type ReflectionQueueCounts = {
  readonly total: number;
  readonly unclaimed: number;
  readonly claimed: number;
  /** Unclaimed rows the claim path skips forever because they spent their attempts. */
  readonly exhausted: number;
  readonly oldestUnclaimedAt: string | undefined;
};

type Conditions = {
  readonly sql: string;
  readonly parameters: unknown[];
};

function conditions(filter: ReflectionQueueFilter, extra: readonly string[] = []): Conditions {
  const clauses = [...extra];
  const parameters: unknown[] = [];
  if (filter.sessionId !== undefined) {
    clauses.push('session_id = ?');
    parameters.push(filter.sessionId);
  }
  if (filter.lane !== undefined) {
    clauses.push('lane = ?');
    parameters.push(filter.lane);
  }
  return { sql: clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`, parameters };
}

/** Insertion order, which is the order the same filter's rows would be claimed in within one lane. */
export function listQueueJobs(
  db: SqliteHandle,
  filter: ReflectionQueueFilter = {},
  limit?: number,
): ReflectionJob[] {
  const where = conditions(filter);
  const bound = limit === undefined ? '' : ' LIMIT ?';
  const parameters = limit === undefined ? where.parameters : [...where.parameters, limit];
  const rows = db
    .prepare(`SELECT * FROM reflection_queue${where.sql} ORDER BY rowid ASC${bound}`)
    .all(...parameters) as ReflectionJobRow[];
  return rows.map(toReflectionJob);
}

export function countQueueJobs(
  db: SqliteHandle,
  filter: ReflectionQueueFilter = {},
  maxAttempts?: number,
): ReflectionQueueCounts {
  const where = conditions(filter);
  const attemptBound = maxAttempts ?? Number.MAX_SAFE_INTEGER;
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN claimed_at IS NULL THEN 1 ELSE 0 END) AS unclaimed,
         SUM(CASE WHEN claimed_at IS NULL AND attempts >= ? THEN 1 ELSE 0 END) AS exhausted,
         MIN(CASE WHEN claimed_at IS NULL THEN enqueued_at ELSE NULL END) AS oldest
       FROM reflection_queue${where.sql}`,
    )
    .get(attemptBound, ...where.parameters) as {
    total: number;
    unclaimed: number | null;
    exhausted: number | null;
    oldest: string | null;
  };

  const unclaimed = row.unclaimed ?? 0;
  return {
    total: row.total,
    unclaimed,
    claimed: row.total - unclaimed,
    exhausted: row.exhausted ?? 0,
    oldestUnclaimedAt: row.oldest ?? undefined,
  };
}

/** Depth per lane, for the surfaces that report where the backlog actually sits. */
export function countQueueJobsByLane(db: SqliteHandle): Map<ReflectionLane, number> {
  const rows = db
    .prepare(
      `SELECT lane, COUNT(*) AS pending FROM reflection_queue
       WHERE claimed_at IS NULL GROUP BY lane`,
    )
    .all() as { lane: string | null; pending: number }[];
  const counts = new Map<ReflectionLane, number>();
  for (const row of rows) {
    const lane: ReflectionLane = row.lane === 'bulk' ? 'bulk' : DEFAULT_REFLECTION_LANE;
    counts.set(lane, (counts.get(lane) ?? 0) + row.pending);
  }
  return counts;
}

/**
 * Drops matching unclaimed rows and answers how many went. The episodes stay in the graph,
 * stored and vectored: what is dropped is the intent to enrich them, which `reconcile`
 * counts and can hand back. Dropping everything with no filter is allowed — a flood is
 * sometimes the whole queue — so the caller is the one that must confirm the count first.
 */
export function dropUnclaimedJobs(db: SqliteHandle, filter: ReflectionQueueFilter = {}): number {
  const where = conditions(filter, ['claimed_at IS NULL']);
  return db.prepare(`DELETE FROM reflection_queue${where.sql}`).run(...where.parameters).changes;
}

/**
 * Moves matching unclaimed rows into the interactive lane, where the next claim takes them
 * ahead of everything bulk. Already-interactive rows are excluded so the count reported is
 * the number of jobs that actually changed lane.
 */
export function promoteJobs(db: SqliteHandle, filter: ReflectionQueueFilter = {}): number {
  const where = conditions(filter, ['claimed_at IS NULL', "lane <> 'interactive'"]);
  return db
    .prepare(`UPDATE reflection_queue SET lane = 'interactive'${where.sql}`)
    .run(...where.parameters).changes;
}
