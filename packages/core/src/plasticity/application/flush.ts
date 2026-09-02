import type { Driver } from 'neo4j-driver';

import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import {
  reinforceEdgeWeights,
  type WeightReinforcement,
} from '../../infrastructure/graph/edge-weights.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  claimReinforcementSignals,
  deleteReinforcementSignals,
  recordReinforcementFlush,
} from '../../infrastructure/sqlite/reinforcement-queue.js';
import { aggregateWindow, type AggregatedPair } from '../domain/reinforcement.js';

/**
 * The Hebbian flush: one callable operation, run to completion and returning what it did.
 *
 * It is a function rather than a loop or a timer because the introspector owns cadence. Recall
 * and reflection nominate pairs on their own hot paths and pay a local SQLite insert for it;
 * everything expensive (the grouping scan, the graph write) happens here, on whatever schedule
 * the decision engine picks, and never inside a user's request.
 *
 * One call drains at most one batch. A caller that wants the queue empty calls again while
 * `signalsClaimed` is positive.
 */

export type HebbianFlushDeps = {
  readonly driver: Driver;
  readonly db: SqliteHandle;
  readonly logger: Logger;
};

export type HebbianFlushOptions = {
  readonly batchSize?: number;
  readonly learningRate?: number;
  readonly weightFloor?: number;
  readonly now?: Date;
};

export type HebbianFlushReport = {
  /** Queue rows this call took, which can exceed the batch size by the last burst it claimed. */
  readonly signalsClaimed: number;
  /** Distinct node pairs the window folded down to. */
  readonly pairsApplied: number;
  /** Edges the graph actually moved: a nominated pair with no edge between it moves nothing. */
  readonly edgesUpdated: number;
  readonly signalsDeleted: number;
};

const EMPTY_REPORT: HebbianFlushReport = {
  signalsClaimed: 0,
  pairsApplied: 0,
  edgesUpdated: 0,
  signalsDeleted: 0,
};

function toWeightReinforcements(pairs: readonly AggregatedPair[]): readonly WeightReinforcement[] {
  return pairs.map((pair) => ({
    sourceId: pair.sourceId,
    targetId: pair.targetId,
    learningRate: pair.learningRate,
  }));
}

/**
 * Claim, fold, apply, delete.
 *
 * The graph write lands before the rows go, so the failure mode is at-least-once: a crash
 * between the two replays the window and applies a second bounded step. The bound is what
 * makes that acceptable, since the replay can only move the weight a diminishing fraction
 * closer to 1.0 and can never pass it. Deleting first would lose the signal instead, and a
 * lost co-activation is not recoverable from anywhere.
 *
 * A graph failure leaves the rows in place and throws, so the next flush retries the same
 * window rather than dropping it.
 *
 * A caller that names no batch size, rate or floor gets the shipped knob. `hebbian.weightFloor`
 * and `recall.associationStrength` sit at the same number, so nothing this writes becomes
 * untraversable.
 */
export async function flushReinforcementQueue(
  deps: HebbianFlushDeps,
  options: HebbianFlushOptions = {},
): Promise<HebbianFlushReport> {
  const batchSize = options.batchSize ?? DEFAULTS.hebbian.batchSize;
  const learningRate = options.learningRate ?? DEFAULTS.hebbian.learningRate;
  const weightFloor = options.weightFloor ?? DEFAULTS.hebbian.weightFloor;
  const now = options.now ?? new Date();

  const signals = claimReinforcementSignals(deps.db, batchSize);
  if (signals.length === 0) {
    recordReinforcementFlush(deps.db, {
      signalsApplied: 0,
      pairsApplied: 0,
      edgesUpdated: 0,
      at: now.toISOString(),
    });
    return EMPTY_REPORT;
  }

  const pairs = aggregateWindow(signals, learningRate);
  const edges = await reinforceEdgeWeights(deps.driver, {
    pairs: toWeightReinforcements(pairs),
    weightFloor,
    now,
  });

  const signalsDeleted = deleteReinforcementSignals(
    deps.db,
    signals.map((signal) => signal.id),
  );

  recordReinforcementFlush(deps.db, {
    signalsApplied: signals.length,
    pairsApplied: pairs.length,
    edgesUpdated: edges.length,
    at: now.toISOString(),
  });

  const report: HebbianFlushReport = {
    signalsClaimed: signals.length,
    pairsApplied: pairs.length,
    edgesUpdated: edges.length,
    signalsDeleted,
  };
  // The two fold aggregates ride the log rather than the report: how much evidence a window
  // spent is an operator's question, and every caller of this function wants the counts above.
  deps.logger.debug(
    {
      ...report,
      signalsFolded: pairs.reduce((sum, pair) => sum + pair.signalCount, 0),
      pairsSaturated: pairs.filter((pair) => pair.effectiveSignal >= 1).length,
    },
    'hebbian flush applied',
  );
  return report;
}
