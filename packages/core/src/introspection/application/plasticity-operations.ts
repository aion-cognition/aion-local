import { sweepEdgeDecay } from '../../plasticity/application/decay.js';
import {
  DEFAULT_HEBBIAN_BATCH_SIZE,
  flushReinforcementQueue,
} from '../../plasticity/application/flush.js';
import type { HealthSnapshot } from '../domain/health.js';
import type { IntrospectionOperation, OperationOutcome } from '../domain/operation.js';

/**
 * Adapts the existing reinforcement flush and decay sweep to the operation contract, adding
 * no behaviour of its own beyond relevance and outcome shape.
 */

export const REINFORCEMENT_FLUSH_OPERATION = 'reinforcement_flush';
export const MEMORY_DECAY_OPERATION = 'memory_decay';

/**
 * Decay has no queue and no gauge that says how much there is to do: it scans the graph's own
 * stalest edges, and a healthy graph legitimately has none. This is the floor it keeps once a
 * sweep is current, so a graph with edges to decay never reads as fully irrelevant between
 * sweeps; `memoryDecayRelevance` ramps above it as the wait since the last sweep grows.
 */
export const DECAY_STANDING_RELEVANCE = 0.15;

/**
 * Hours of standing wait at which decay's own relevance, with no starvation boost from the
 * engine, clears the default urgency threshold on its own. A personal graph accrues cycles
 * slowly enough that the generic starvation mechanism (cycles waited, not wall time) may never
 * carry decay there on its own; this makes the operation self-sufficient instead of depending
 * on scale it may never reach. Never having run reads as an infinite wait, so a fresh substrate
 * with something to decay does not need a first successful sweep before this applies to it.
 */
export const DECAY_STALE_HOURS = 4;

const MS_PER_HOUR = 60 * 60 * 1000;

/** `Infinity` for "never run", which folds that case into the same ramp as "run a while ago". */
function hoursSinceDecay(health: HealthSnapshot): number {
  const { decayLastRunAt } = health.plasticity;
  if (decayLastRunAt === undefined) {
    return Number.POSITIVE_INFINITY;
  }
  const elapsedMs = Date.parse(health.observedAt) - Date.parse(decayLastRunAt);
  return Math.max(0, elapsedMs) / MS_PER_HOUR;
}

/**
 * Zero when the graph has no unprotected edge to act on: relevance answers "is there work",
 * and a sweep that would scan and change nothing is not work. Otherwise the standing floor,
 * ramped linearly by how long it has been since the last sweep (or since the operation was
 * born, if it never ran) until `DECAY_STALE_HOURS` in, where it saturates at full relevance.
 */
export function memoryDecayRelevance(health: HealthSnapshot): number {
  if (health.graph.decayableEdges <= 0) {
    return 0;
  }
  const staleness = Math.min(1, hoursSinceDecay(health) / DECAY_STALE_HOURS);
  return Math.max(DECAY_STANDING_RELEVANCE, staleness);
}

/**
 * One flush drains at most one batch, so a full batch waiting is full relevance. Depth beyond
 * that does not make the operation more urgent, it makes it repeat: the next quarter-hour
 * bucket takes the next batch. Absolute rather than scaled by the graph's own size, so a
 * backlog this large on a personal graph reads exactly as urgent as the same backlog on a
 * heavily used one: at two fifths of one batch this already clears the default urgency
 * threshold even at the deprioritized weight an operation under the effectiveness floor is
 * scored at, so starvation is a backstop here, not the mechanism the reading depends on.
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
    relevance: memoryDecayRelevance,
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
