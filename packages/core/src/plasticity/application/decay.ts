import type { Driver } from 'neo4j-driver';
import { decayEdgeWeights } from '../../infrastructure/graph/edge-weights.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { recordDecaySweep } from '../../infrastructure/sqlite/decay-counters.js';
import { DEFAULT_HEBBIAN_BATCH_SIZE, DEFAULT_HEBBIAN_WEIGHT_FLOOR } from './flush.js';

/**
 * The Hebbian decay sweep: one callable operation, run to completion and returning what it
 * did. Like the flush it sits beside, it is a function rather than a loop or a timer: the
 * introspector owns cadence, and this reads and moves one bounded batch of the graph's own
 * stalest edges each time it is called.
 *
 * There is no queue behind it. Reinforcement drains signals recall and reflection already
 * nominated; decay has no nominations to drain, so it scans the graph itself for candidates,
 * oldest-touched first (`edge-weights.ts`'s `buildEdgeWeightDecay`). One call's writes are
 * what make the next call's scan move on: every edge this call decays gets a fresh
 * `updated_at`, so it ranks behind whatever is still stale next time, with no cursor to
 * track between calls.
 */

/** Matches `hebbian.decayRate`: eta_decay in `w' = max(floor, w - eta_decay * decay)`. */
export const DEFAULT_HEBBIAN_DECAY_RATE = 0.05;

/** Matches `hebbian.decayPeakDays`: the staleness, in days, where the bell curve peaks. */
export const DEFAULT_HEBBIAN_DECAY_PEAK_DAYS = 30;

/** Matches `hebbian.decaySigma`: the curve's spread around the peak. */
export const DEFAULT_HEBBIAN_DECAY_SIGMA = 15;

export type HebbianDecayDeps = {
  readonly driver: Driver;
  readonly db: SqliteHandle;
  readonly logger: Logger;
};

export type HebbianDecayOptions = {
  readonly batchSize?: number;
  readonly decayRate?: number;
  readonly peakDays?: number;
  readonly sigma?: number;
  readonly weightFloor?: number;
  readonly now?: Date;
};

export type HebbianDecayReport = {
  /** Unprotected edges the scan examined this run, bounded by batchSize. */
  readonly edgesScanned: number;
  /** Of those, the ones whose weight actually moved; the rest were already at the floor. */
  readonly edgesDecayed: number;
};

/**
 * Scan, decay, record. Unlike the flush, there is no cheap "is there anything to do" check
 * to skip ahead of the graph call: the scan itself is that check, and an empty result is a
 * normal outcome rather than a special case.
 */
export async function sweepEdgeDecay(
  deps: HebbianDecayDeps,
  options: HebbianDecayOptions = {},
): Promise<HebbianDecayReport> {
  const batchSize = options.batchSize ?? DEFAULT_HEBBIAN_BATCH_SIZE;
  const decayRate = options.decayRate ?? DEFAULT_HEBBIAN_DECAY_RATE;
  const peakDays = options.peakDays ?? DEFAULT_HEBBIAN_DECAY_PEAK_DAYS;
  const sigma = options.sigma ?? DEFAULT_HEBBIAN_DECAY_SIGMA;
  const weightFloor = options.weightFloor ?? DEFAULT_HEBBIAN_WEIGHT_FLOOR;
  const now = options.now ?? new Date();

  const edges = await decayEdgeWeights(deps.driver, {
    batchSize,
    decayRate,
    peakDays,
    sigma,
    weightFloor,
    now,
  });

  const edgesDecayed = edges.filter((edge) => edge.strength !== edge.previousStrength).length;
  const report: HebbianDecayReport = { edgesScanned: edges.length, edgesDecayed };

  recordDecaySweep(deps.db, {
    edgesScanned: report.edgesScanned,
    edgesDecayed: report.edgesDecayed,
    at: now.toISOString(),
  });
  deps.logger.debug({ ...report }, 'hebbian decay sweep applied');
  return report;
}
