import type { Driver } from 'neo4j-driver';
import {
  edgeWeightDistribution,
  type EdgeWeightDistribution,
} from '../../infrastructure/graph/edge-weight-distribution.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { decaySweepCounters, type DecaySweepCounters } from '../../infrastructure/sqlite/decay-counters.js';
import {
  countReinforcementSignals,
  reinforcementFlushCounters,
  reinforcementQueueDroppedCount,
  type ReinforcementFlushCounters,
} from '../../infrastructure/sqlite/reinforcement-queue.js';

/**
 * What plasticity has done to the graph, read back for an operator rather than argued from
 * design intent. Split the way `queueLagSnapshot` (`reflection/application/lag.ts`) is split:
 * `plasticityCounters` is SQLite-only, so `/health` can call it on every liveness probe, and
 * the edge-weight distribution stays out of it because it is a graph read. `plasticitySnapshot`
 * adds that one bounded read on top, for `aion status` and `doctor`, which call it on demand
 * rather than on a clock.
 */

export type PlasticityCounters = {
  readonly reinforcement: ReinforcementFlushCounters;
  readonly reinforcementDropped: number;
  /** Rows still waiting on the next flush, not a cumulative count. */
  readonly reinforcementQueueDepth: number;
  readonly decay: DecaySweepCounters;
};

export function plasticityCounters(db: SqliteHandle): PlasticityCounters {
  return {
    reinforcement: reinforcementFlushCounters(db),
    reinforcementDropped: reinforcementQueueDroppedCount(db),
    reinforcementQueueDepth: countReinforcementSignals(db),
    decay: decaySweepCounters(db),
  };
}

export type PlasticitySnapshot = PlasticityCounters & {
  readonly edgeWeights: EdgeWeightDistribution;
};

export async function plasticitySnapshot(driver: Driver, db: SqliteHandle): Promise<PlasticitySnapshot> {
  const edgeWeights = await edgeWeightDistribution(driver);
  return { ...plasticityCounters(db), edgeWeights };
}
