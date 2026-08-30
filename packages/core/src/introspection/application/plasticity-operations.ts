import { sweepEdgeDecay } from '../../plasticity/application/decay.js';
import {
  DEFAULT_HEBBIAN_BATCH_SIZE,
  flushReinforcementQueue,
} from '../../plasticity/application/flush.js';
import type { HealthSnapshot } from '../domain/health.js';
import type { IntrospectionOperation, OperationOutcome } from '../domain/operation.js';

/**
 * The first two registered operations. Both already existed as callable, bounded functions
 * with the introspector named as their scheduler; this is the adapter that finally schedules
 * them, and it adds no behaviour of its own beyond the contract's relevance and outcome.
 */

export const REINFORCEMENT_FLUSH_OPERATION = 'reinforcement_flush';
export const MEMORY_DECAY_OPERATION = 'memory_decay';

/**
 * Decay has no queue and no gauge that says how much there is to do: it scans the graph's own
 * stalest edges, and a healthy graph legitimately has none. So it declares a low standing
 * relevance and reaches the threshold on waiting time, which is what "scheduled cadence" means
 * in a loop where everything else is triggered.
 */
export const DECAY_STANDING_RELEVANCE = 0.15;

/**
 * One flush drains at most one batch, so a full batch waiting is full relevance. Depth beyond
 * that does not make the operation more urgent, it makes it repeat: the next quarter-hour
 * bucket takes the next batch.
 */
export function reinforcementFlushRelevance(health: HealthSnapshot): number {
  return Math.min(1, health.plasticity.reinforcementQueueDepth / DEFAULT_HEBBIAN_BATCH_SIZE);
}

export function reinforcementFlushOperation(): IntrospectionOperation {
  return {
    name: REINFORCEMENT_FLUSH_OPERATION,
    bucket: 'quarter-hour',
    relevance: reinforcementFlushRelevance,
    measure: (health) => health.plasticity.reinforcementQueueDepth,
    improves: 'lower',
    run: async (ctx): Promise<OperationOutcome> => {
      const report = await flushReinforcementQueue(
        { driver: ctx.driver, db: ctx.db, logger: ctx.logger },
        {
          batchSize: ctx.config.hebbian.batchSize,
          learningRate: ctx.config.hebbian.learningRate,
          weightFloor: ctx.config.hebbian.weightFloor,
          now: ctx.now,
        },
      );
      return {
        status: report.signalsClaimed === 0 ? 'noop' : 'applied',
        itemsProcessed: report.signalsClaimed,
        itemsAffected: report.edgesUpdated,
        detail: `${String(report.pairsApplied)} pairs, ${String(report.edgesUpdated)} edges reinforced`,
      };
    },
  };
}

export function memoryDecayOperation(): IntrospectionOperation {
  return {
    name: MEMORY_DECAY_OPERATION,
    bucket: 'day',
    relevance: () => DECAY_STANDING_RELEVANCE,
    run: async (ctx): Promise<OperationOutcome> => {
      const report = await sweepEdgeDecay(
        { driver: ctx.driver, db: ctx.db, logger: ctx.logger },
        {
          batchSize: ctx.config.hebbian.batchSize,
          decayRate: ctx.config.hebbian.decayRate,
          peakDays: ctx.config.hebbian.decayPeakDays,
          sigma: ctx.config.hebbian.decaySigma,
          weightFloor: ctx.config.hebbian.weightFloor,
          now: ctx.now,
        },
      );
      return {
        status: report.edgesDecayed === 0 ? 'noop' : 'applied',
        itemsProcessed: report.edgesScanned,
        itemsAffected: report.edgesDecayed,
        detail: `${String(report.edgesDecayed)} of ${String(report.edgesScanned)} scanned edges decayed`,
      };
    },
  };
}
