import type { SqliteHandle } from './database.js';
import { getMeta, setMeta } from './meta.js';

const DECAY_META_KEYS = {
  edgesScanned: 'hebbian_decay:edges_scanned',
  edgesDecayed: 'hebbian_decay:edges_decayed',
  lastRunAt: 'hebbian_decay:last_run_at',
} as const;

export type DecaySweepCounters = {
  /** Cumulative across the store's lifetime, like the reinforcement flush counters beside them. */
  readonly edgesScanned: number;
  readonly edgesDecayed: number;
  readonly lastRunAt?: string;
};

export function decaySweepCounters(db: SqliteHandle): DecaySweepCounters {
  const lastRunAt = getMeta(db, DECAY_META_KEYS.lastRunAt);
  return {
    edgesScanned: Number(getMeta(db, DECAY_META_KEYS.edgesScanned) ?? '0'),
    edgesDecayed: Number(getMeta(db, DECAY_META_KEYS.edgesDecayed) ?? '0'),
    ...(lastRunAt === undefined ? {} : { lastRunAt }),
  };
}

export type DecaySweepCounts = {
  readonly edgesScanned: number;
  readonly edgesDecayed: number;
  readonly at: string;
};

/**
 * Counters `status`/`doctor` and the introspector read the same way they read the flush's:
 * `lastRunAt` advances on an empty sweep too, which separates a graph with nothing stale
 * enough to touch from a sweep that has stopped running.
 */
export function recordDecaySweep(db: SqliteHandle, counts: DecaySweepCounts): void {
  // The read and the three writes are one unit: totals added to a base another sweep has
  // already moved past are that sweep's totals thrown away. Immediate takes the write lock
  // at BEGIN, so a second sweep waits out busy_timeout instead of failing on a stale snapshot.
  db.transaction(() => {
    const current = decaySweepCounters(db);
    setMeta(db, DECAY_META_KEYS.edgesScanned, String(current.edgesScanned + counts.edgesScanned));
    setMeta(db, DECAY_META_KEYS.edgesDecayed, String(current.edgesDecayed + counts.edgesDecayed));
    setMeta(db, DECAY_META_KEYS.lastRunAt, counts.at);
  }).immediate();
}
