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
 * Matches `sqlite.reinforcementQueueCap`'s default (`config/defaults.ts`, parity asserted in
 * `stage-defaults.test.ts`). A rolling window is closer to Hebbian semantics than an
 * unbounded log, since nothing drains this table yet.
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
 */
function trimToCapacity(db: SqliteHandle, cap: number): void {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM reinforcement_queue').get() as {
    count: number;
  };
  const overflow = count - cap;
  if (overflow <= 0) {
    return;
  }
  db.prepare(
    `DELETE FROM reinforcement_queue WHERE rowid IN (
       SELECT rowid FROM reinforcement_queue ORDER BY rowid ASC LIMIT ?
     )`,
  ).run(overflow);
  setMeta(db, DROPPED_COUNT_META_KEY, String(reinforcementQueueDroppedCount(db) + overflow));
}

/**
 * Enqueue only; flushing into Hebbian reinforcement comes later. Past `cap` the oldest
 * rows are dropped to make room, counted in `meta` under
 * `reinforcement_queue:dropped_count`: the table has no consumer yet, so an unbounded
 * insert rate has nowhere else to go but disk.
 */
export function enqueueReinforcementSignal(
  db: SqliteHandle,
  sourceId: string,
  targetId: string,
  trigger: string,
  ts: string = new Date().toISOString(),
  cap: number = DEFAULT_REINFORCEMENT_QUEUE_CAP,
): string {
  const id = randomUUID();
  db.prepare(
    'INSERT INTO reinforcement_queue (id, source_id, target_id, trigger, ts) VALUES (?, ?, ?, ?, ?)',
  ).run(id, sourceId, targetId, trigger, ts);
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
