import { randomUUID } from 'node:crypto';

import type { SqliteHandle } from './database.js';
import { getMeta, setMeta } from './meta.js';

export type ReinforcementSignal = {
  id: string;
  sourceId: string;
  targetId: string;
  trigger: string;
  ts: string;
};

type ReinforcementSignalRow = {
  id: string;
  source_id: string;
  target_id: string;
  trigger: string;
  ts: string;
};

type SignalBurstRow = {
  burst: string;
  lo: number;
  n: number;
};

/**
 * How a burst is identified in SQL. `burst_id` is the producer's own name for the set of rows
 * it wrote in one go; a row written before that column existed falls back to the trigger and
 * the timestamp, which is all such a row carries.
 */
const BURST_KEY = "COALESCE(burst_id, trigger || ':' || ts)";

function toReinforcementSignal(row: ReinforcementSignalRow): ReinforcementSignal {
  return {
    id: row.id,
    sourceId: row.source_id,
    targetId: row.target_id,
    trigger: row.trigger,
    ts: row.ts,
  };
}

/**
 * `knobs.ts` imports this constant as `sqlite.reinforcementQueueCap`'s default, so there is one
 * value rather than two to keep in step. A rolling window is closer to Hebbian semantics than an
 * unbounded log: signals older than the window stand for co-activations the graph has already
 * moved on from.
 */
export const DEFAULT_REINFORCEMENT_QUEUE_CAP = 50_000;

const DROPPED_COUNT_META_KEY = 'reinforcement_queue:dropped_count';

/** Cumulative rows dropped by the cap across the store's lifetime, for `doctor`/`status` to surface. */
export function reinforcementQueueDroppedCount(db: SqliteHandle): number {
  return Number(getMeta(db, DROPPED_COUNT_META_KEY) ?? '0');
}

/**
 * Oldest-first past `cap`. A separate statement from the insert rather than one transaction:
 * a crash between the two leaves the table at most one row over cap, which the next enqueue
 * call trims away, so nothing but a rolling window is at stake.
 *
 * The occupancy check is `MAX(rowid) - MIN(rowid)`, two O(1) index lookups, and not
 * `COUNT(*)`, which is a full scan the caller would pay on every insert: recall enqueues
 * roughly 45 of these inline, so at a steady-state 50,000 rows that is 45 full scans per
 * recall on the interactive path. The span equals the count because the only delete in this
 * module is this one and it always takes the oldest rows; a future arbitrary delete would
 * make the span an overestimate and cost the window a few extra rows, never correctness.
 */
function trimToCapacity(db: SqliteHandle, cap: number): void {
  const bounds = db
    .prepare('SELECT MIN(rowid) AS lo, MAX(rowid) AS hi FROM reinforcement_queue')
    .get() as { lo: number | null; hi: number | null };
  if (bounds.lo === null || bounds.hi === null) {
    return;
  }
  const overflow = bounds.hi - bounds.lo + 1 - cap;
  if (overflow <= 0) {
    return;
  }
  const firstKept = bounds.lo + overflow;
  // The delete and the counter are one unit: a total added to a base another connection has
  // already moved past is that trim's drops thrown away.
  db.transaction(() => {
    const dropped = db
      .prepare('DELETE FROM reinforcement_queue WHERE rowid < ?')
      .run(firstKept).changes;
    setMeta(db, DROPPED_COUNT_META_KEY, String(reinforcementQueueDroppedCount(db) + dropped));
  }).immediate();
}

/**
 * Past `cap` the oldest rows are dropped to make room, counted in `meta` under
 * `reinforcement_queue:dropped_count`. The flush drains the table on the introspector's
 * cadence, and the cap is what keeps a burst of writes between two flushes off the disk.
 */
export function enqueueReinforcementSignal(
  db: SqliteHandle,
  sourceId: string,
  targetId: string,
  trigger: string,
  ts: string = new Date().toISOString(),
  cap: number = DEFAULT_REINFORCEMENT_QUEUE_CAP,
  burstId?: string,
): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO reinforcement_queue (id, source_id, target_id, trigger, ts, burst_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, sourceId, targetId, trigger, ts, burstId ?? null);
  trimToCapacity(db, cap);
  return id;
}

/** Ordered by insertion (rowid), not ts: same-millisecond bursts would tie on the latter. */
export function listReinforcementSignals(db: SqliteHandle): ReinforcementSignal[] {
  const rows = db
    .prepare('SELECT * FROM reinforcement_queue ORDER BY rowid ASC')
    .all() as ReinforcementSignalRow[];
  return rows.map(toReinforcementSignal);
}

export function countReinforcementSignals(db: SqliteHandle): number {
  const row = db.prepare('SELECT count(*) AS n FROM reinforcement_queue').get() as { n: number };
  return row.n;
}

/**
 * The oldest bursts, whole. A burst is the set of rows one producer wrote in one go under one
 * `burst_id`: an episode's co-extraction pairs, or one recall's co-activated pairs.
 *
 * Batching by burst rather than by row is what makes the clique discount computable. The
 * discount needs to know how many nodes the burst touched, and that is only readable from a
 * burst that arrives whole; half an episode's pairs read as a smaller, less discounted clique
 * and would apply more weight than the whole episode does. So `batchSize` is a floor the claim
 * rounds up to the end of a burst, and one flush can exceed it by at most the size of the last
 * burst it took.
 *
 * The grouping pass scans the table, which the row-level path deliberately never does. The
 * flush runs on the introspector's cadence rather than on the recall hot path, so a scan of a
 * capped table is the cheap side of this trade.
 */
export function claimReinforcementSignals(
  db: SqliteHandle,
  batchSize: number,
): ReinforcementSignal[] {
  if (batchSize <= 0) {
    return [];
  }

  const bursts = db
    .prepare(
      `SELECT ${BURST_KEY} AS burst, MIN(rowid) AS lo, count(*) AS n
       FROM reinforcement_queue
       GROUP BY burst
       ORDER BY lo ASC
       LIMIT ?`,
    )
    .all(batchSize) as SignalBurstRow[];

  const claimed: SignalBurstRow[] = [];
  let rows = 0;
  for (const burst of bursts) {
    if (rows >= batchSize) {
      break;
    }
    claimed.push(burst);
    rows += burst.n;
  }
  if (claimed.length === 0) {
    return [];
  }

  const placeholders = claimed.map(() => '?').join(', ');
  const selected = db
    .prepare(
      `SELECT * FROM reinforcement_queue
       WHERE ${BURST_KEY} IN (${placeholders})
       ORDER BY rowid ASC`,
    )
    .all(...claimed.map((burst) => burst.burst)) as ReinforcementSignalRow[];
  return selected.map(toReinforcementSignal);
}

/**
 * Chunked because the id list is unbounded in principle: a claim rounds up to a whole burst,
 * and nothing caps how many pairs one producer writes at once.
 */
const DELETE_CHUNK_SIZE = 500;

/** Applied signals leave the queue. A row is a nomination, and the durable record of it is the edge weight. */
export function deleteReinforcementSignals(db: SqliteHandle, ids: readonly string[]): number {
  let removed = 0;
  for (let start = 0; start < ids.length; start += DELETE_CHUNK_SIZE) {
    const chunk = ids.slice(start, start + DELETE_CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(', ');
    removed += db
      .prepare(`DELETE FROM reinforcement_queue WHERE id IN (${placeholders})`)
      .run(...chunk).changes;
  }
  return removed;
}

const FLUSH_META_KEYS = {
  signals: 'hebbian_flush:signals_applied',
  pairs: 'hebbian_flush:pairs_applied',
  edges: 'hebbian_flush:edges_updated',
  lastRunAt: 'hebbian_flush:last_run_at',
} as const;

export type ReinforcementFlushCounters = {
  /** Cumulative across the store's lifetime, like the dropped counter beside them. */
  readonly signalsApplied: number;
  readonly pairsApplied: number;
  readonly edgesUpdated: number;
  readonly lastRunAt?: string;
};

export function reinforcementFlushCounters(db: SqliteHandle): ReinforcementFlushCounters {
  const lastRunAt = getMeta(db, FLUSH_META_KEYS.lastRunAt);
  return {
    signalsApplied: Number(getMeta(db, FLUSH_META_KEYS.signals) ?? '0'),
    pairsApplied: Number(getMeta(db, FLUSH_META_KEYS.pairs) ?? '0'),
    edgesUpdated: Number(getMeta(db, FLUSH_META_KEYS.edges) ?? '0'),
    ...(lastRunAt === undefined ? {} : { lastRunAt }),
  };
}

export type ReinforcementFlushCounts = {
  readonly signalsApplied: number;
  readonly pairsApplied: number;
  readonly edgesUpdated: number;
  readonly at: string;
};

/**
 * Counters `status` and the introspector read to tell reinforcement outrunning decay from
 * a flush that has stopped running at all. `lastRunAt` moves on an empty flush too, which is
 * what separates a quiet queue from a stalled operation.
 */
export function recordReinforcementFlush(db: SqliteHandle, counts: ReinforcementFlushCounts): void {
  // The read and the four writes are one unit, as in the decay sweep's counters: totals added
  // to a base another flush has already moved past are that flush's totals thrown away.
  // Immediate takes the write lock at BEGIN, so a second flush waits out busy_timeout instead
  // of working from a stale snapshot.
  db.transaction(() => {
    const current = reinforcementFlushCounters(db);
    setMeta(db, FLUSH_META_KEYS.signals, String(current.signalsApplied + counts.signalsApplied));
    setMeta(db, FLUSH_META_KEYS.pairs, String(current.pairsApplied + counts.pairsApplied));
    setMeta(db, FLUSH_META_KEYS.edges, String(current.edgesUpdated + counts.edgesUpdated));
    setMeta(db, FLUSH_META_KEYS.lastRunAt, counts.at);
  }).immediate();
}
