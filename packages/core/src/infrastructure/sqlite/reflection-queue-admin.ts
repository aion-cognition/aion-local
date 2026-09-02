import type { SqliteHandle } from './database.js';
import {
  toReflectionJob,
  toReflectionLane,
  type ReflectionJob,
  type ReflectionJobRow,
  type ReflectionLane,
} from './reflection-queue.js';

/**
 * The operator's view of `reflection_queue`.
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
  /**
   * Unclaimed and still claimable: `unclaimed` minus `exhausted`. This is the backlog, and it
   * is what every freshness gauge reads. Counting a permanently dead row as pending is how one
   * wedged job made a drained queue report an eight-hour backlog.
   */
  readonly pending: number;
  /** Oldest row that will actually be claimed. An exhausted row's age is not a wait time. */
  readonly oldestPendingAt: string | undefined;
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
         MIN(CASE WHEN claimed_at IS NULL AND attempts < ? THEN enqueued_at ELSE NULL END) AS oldest
       FROM reflection_queue${where.sql}`,
    )
    .get(attemptBound, attemptBound, ...where.parameters) as {
    total: number;
    unclaimed: number | null;
    exhausted: number | null;
    oldest: string | null;
  };

  const unclaimed = row.unclaimed ?? 0;
  const exhausted = row.exhausted ?? 0;
  return {
    total: row.total,
    unclaimed,
    claimed: row.total - unclaimed,
    exhausted,
    pending: unclaimed - exhausted,
    oldestPendingAt: row.oldest ?? undefined,
  };
}

/**
 * Depth per lane, for the surfaces that report where the backlog actually sits. Exhausted rows
 * are excluded for the same reason they are excluded from `pending`: the claim path skips them,
 * so counting them as depth reports work nobody will do.
 */
export function countQueueJobsByLane(
  db: SqliteHandle,
  filter: ReflectionQueueFilter = {},
  maxAttempts: number = Number.MAX_SAFE_INTEGER,
): Map<ReflectionLane, number> {
  const where = conditions(filter, ['claimed_at IS NULL', 'attempts < ?']);
  const rows = db
    .prepare(`SELECT lane, COUNT(*) AS pending FROM reflection_queue${where.sql} GROUP BY lane`)
    .all(maxAttempts, ...where.parameters) as { lane: string | null; pending: number }[];
  const counts = new Map<ReflectionLane, number>();
  for (const row of rows) {
    const lane = toReflectionLane(row.lane);
    counts.set(lane, (counts.get(lane) ?? 0) + row.pending);
  }
  return counts;
}

/**
 * Drops matching unclaimed rows and answers how many went. The episodes stay in the graph,
 * stored and vectored: what is dropped is the intent to enrich them, which `reconcile`
 * counts and can hand back. Dropping everything with no filter is allowed, since a flood
 * is sometimes the whole queue, so the caller is the one that must confirm the count first.
 */
export function dropUnclaimedJobs(db: SqliteHandle, filter: ReflectionQueueFilter = {}): number {
  const where = conditions(filter, ['claimed_at IS NULL']);
  return db.prepare(`DELETE FROM reflection_queue${where.sql}`).run(...where.parameters).changes;
}

/**
 * Moves matching unclaimed rows into the interactive lane, where the next claim takes them
 * ahead of everything bulk. Already-interactive rows are excluded so the count reported is
 * the number of jobs that actually changed lane.
 *
 * A row takes a fresh `lane_seq` from the interactive group it lands in, because the column
 * numbers a row within its own (lane, session) group. Carrying a bulk turn across would sort
 * the row against interactive rows that never shared its counter, and the next enqueue for
 * that session would take its high-water mark from a number the bulk backlog set. One
 * statement per row so each reads the mark the row before it left.
 */
export function promoteJobs(db: SqliteHandle, filter: ReflectionQueueFilter = {}): number {
  const where = conditions(filter, ['claimed_at IS NULL', "lane <> 'interactive'"]);
  const rows = db
    .prepare(`SELECT id FROM reflection_queue${where.sql} ORDER BY lane_seq ASC, rowid ASC`)
    .all(...where.parameters) as { id: string }[];
  const promote = db.prepare(
    `UPDATE reflection_queue
       SET lane = 'interactive',
           lane_seq = (
             SELECT COALESCE(MAX(q.lane_seq), 0) + 1 FROM reflection_queue q
             WHERE q.lane = 'interactive' AND q.session_id IS reflection_queue.session_id
           )
     WHERE id = ? AND claimed_at IS NULL AND lane <> 'interactive'`,
  );
  const promoteAll = db.transaction((ids: readonly string[]) => {
    let moved = 0;
    for (const id of ids) {
      moved += promote.run(id).changes;
    }
    return moved;
  });
  return promoteAll(rows.map((row) => row.id));
}
