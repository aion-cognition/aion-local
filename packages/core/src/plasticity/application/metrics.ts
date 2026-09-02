import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  decaySweepCounters,
  type DecaySweepCounters,
} from '../../infrastructure/sqlite/decay-counters.js';
import {
  countReinforcementSignals,
  reinforcementFlushCounters,
  reinforcementQueueDroppedCount,
  type ReinforcementFlushCounters,
} from '../../infrastructure/sqlite/reinforcement-queue.js';

/**
 * What plasticity has done to the graph, read back for an operator rather than argued from
 * design intent. Every field here is a SQLite read, the boundary `queueLagSnapshot`
 * (`reflection/application/lag.ts`) draws for the same reason: `/health` calls this on every
 * liveness probe. The edge-weight distribution is a graph read, so it stays out; `aion status`
 * and `doctor` ask `edgeWeightDistribution` for it themselves, on demand rather than on a clock.
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
