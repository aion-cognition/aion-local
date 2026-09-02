import type { Driver } from 'neo4j-driver';

import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { decayEdgeWeights } from '../../infrastructure/graph/edge-weights.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { recordDecaySweep } from '../../infrastructure/sqlite/decay-counters.js';

/**
 * The Hebbian decay sweep: one callable operation, run to completion and returning what it
 * did. Like the flush it sits beside, it is a function rather than a loop or a timer: the
 * introspector owns cadence, and this reads and moves one bounded batch of the graph's own
 * stalest edges each time it is called.
 *
 * There is no queue behind it. Reinforcement drains signals recall and reflection already
 * nominated; decay has no nominations to drain, so it scans the graph itself for candidates
 * (`edge-weights.ts`'s `buildEdgeWeightDecay`). The scan takes the edges it has gone longest
 * without visiting, never-visited ones first, so successive calls cover the graph in turns
 * rather than re-taking one slice. How far a weight moves is a separate question, answered by
 * how long the edge has gone unused, which the sweep leaves alone.
 */

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
  /**
   * Of those, the ones whose weight changed. An edge already at the floor accounts for most of
   * the rest, and so does one far out in a tail, where the curve's step is too small to move a
   * float.
   */
  readonly edgesDecayed: number;
};

/**
 * Scan, decay, record. Unlike the flush, there is no cheap "is there anything to do" check
 * to skip ahead of the graph call: the scan itself is that check, and an empty result is a
 * normal outcome rather than a special case.
 *
 * A caller that names no rate, peak or sigma gets the shipped knob: `eta_decay` in
 * `w' = min(w, max(floor, w - eta_decay * decay))`, the staleness in days where the bell curve
 * peaks, and the curve's spread around that peak.
 */
export async function sweepEdgeDecay(
  deps: HebbianDecayDeps,
  options: HebbianDecayOptions = {},
): Promise<HebbianDecayReport> {
  const batchSize = options.batchSize ?? DEFAULTS.hebbian.batchSize;
  const decayRate = options.decayRate ?? DEFAULTS.hebbian.decayRate;
  const peakDays = options.peakDays ?? DEFAULTS.hebbian.decayPeakDays;
  const sigma = options.sigma ?? DEFAULTS.hebbian.decaySigma;
  const weightFloor = options.weightFloor ?? DEFAULTS.hebbian.weightFloor;
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
