import { sweepEdgeDecay } from '../../plasticity/application/decay.js';
import {
  flushReinforcementQueue,
  type HebbianFlushReport,
} from '../../plasticity/application/flush.js';
import type { HealthSnapshot } from '../domain/health.js';
import type { IntrospectionOperation, OperationOutcome } from '../domain/operation.js';

/**
 * Adapts the existing reinforcement flush and decay sweep to the operation contract. The flush
 * side adds one behaviour beyond relevance and outcome shape: a bounded per-run drain loop,
 * since arrival on a heavy day outruns what a single claimed batch can clear.
 *
 * Each carries the kill switch every other weight operation carries. Off, the run is a noop:
 * reinforcement rows wait in the queue for a deployment that turns it back on, and stale edges
 * hold the strength they have.
 */

export const REINFORCEMENT_FLUSH_OPERATION = 'reinforcement_flush';
export const MEMORY_DECAY_OPERATION = 'memory_decay';

/**
 * Matches `hebbian.flushCeiling`; parity is asserted in this module's test. `reinforcementFlushRelevance`
 * reads this rather than the config value, since relevance is pure and must answer the same way
 * for a given snapshot regardless of what a deployment has tuned the live ceiling to.
 */
export const DEFAULT_HEBBIAN_FLUSH_CEILING = 2_000;

/** Matches `hebbian.decayScanFraction`; parity is asserted in this module's test. */
export const DEFAULT_HEBBIAN_DECAY_SCAN_FRACTION = 0.15;

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
 * One flush drains until the queue is empty or the run ceiling is hit, so a full ceiling's
 * worth of backlog waiting is full relevance: that is the most one run can clear, and depth
 * beyond it does not make the operation more urgent, it makes it repeat. Absolute rather than
 * scaled by the graph's own size, so a backlog this large on a personal graph reads exactly as
 * urgent as the same backlog on a heavily used one: at two fifths of one ceiling this already
 * clears the default urgency threshold even at the deprioritized weight an operation under the
 * effectiveness floor is scored at, so starvation is a backstop here, not the mechanism the
 * reading depends on.
 */
export function reinforcementFlushRelevance(health: HealthSnapshot): number {
  return Math.min(1, health.plasticity.reinforcementQueueDepth / DEFAULT_HEBBIAN_FLUSH_CEILING);
}

/**
 * The decay sweep's scan quota for this run: a share of the graph's own decayable edges, not a
 * fixed count. Zero edges scans zero rather than a bogus positive floor, since `relevance`
 * already reads that as nothing to do. Otherwise at least one, so a fraction this thin never
 * rounds a graph that does have decayable edges down to scanning none of them.
 */
export function decayScanQuota(decayableEdges: number, fraction: number): number {
  if (decayableEdges <= 0) {
    return 0;
  }
  return Math.max(1, Math.ceil(decayableEdges * fraction));
}

export type ReinforcementDrainReport = HebbianFlushReport & {
  /** Batches the loop actually called `flushReinforcementQueue` for. */
  readonly batches: number;
  /** True when the ceiling stopped the loop with signals still queued, rather than an empty queue. */
  readonly ceilingHit: boolean;
  /** True when the shutdown signal stopped the loop before the queue emptied or the ceiling was hit. */
  readonly aborted: boolean;
};

/**
 * Drains batches until the queue reports empty, the run ceiling is reached, or the signal
 * aborts, whichever comes first. One call can carry the total past the ceiling by up to the
 * size of the last burst it claimed, the same rounding `claimReinforcementSignals` already
 * does inside one batch, extended to the run as a whole.
 *
 * `drainOneBatch` is injected so the loop's own stopping conditions are unit-testable against
 * canned reports, with no queue, database, or graph behind it.
 */
export async function drainReinforcementQueue(
  drainOneBatch: () => Promise<HebbianFlushReport>,
  ceiling: number,
  signal: AbortSignal,
): Promise<ReinforcementDrainReport> {
  let signalsClaimed = 0;
  let pairsApplied = 0;
  let edgesUpdated = 0;
  let signalsDeleted = 0;
  let batches = 0;

  while (signalsClaimed < ceiling && !signal.aborted) {
    const report = await drainOneBatch();
    batches += 1;
    signalsClaimed += report.signalsClaimed;
    pairsApplied += report.pairsApplied;
    edgesUpdated += report.edgesUpdated;
    signalsDeleted += report.signalsDeleted;
    if (report.signalsClaimed === 0) {
      break;
    }
  }

  return {
    signalsClaimed,
    pairsApplied,
    edgesUpdated,
    signalsDeleted,
    batches,
    ceilingHit: signalsClaimed >= ceiling,
    aborted: signal.aborted,
  };
}

export function reinforcementFlushOperation(): IntrospectionOperation {
  return {
    name: REINFORCEMENT_FLUSH_OPERATION,
    bucket: 'quarter-hour',
    relevance: reinforcementFlushRelevance,
    measure: (health) => health.plasticity.reinforcementQueueDepth,
    improves: 'lower',
    run: async (ctx): Promise<OperationOutcome> => {
      if (!ctx.config.maintenance.reinforcementFlush) {
        return {
          status: 'noop',
          itemsProcessed: 0,
          itemsAffected: 0,
          detail:
            'reinforcement disabled by AION_MAINTENANCE_REINFORCEMENT_FLUSH; the queue is left as is',
        };
      }
      const report = await drainReinforcementQueue(
        () =>
          flushReinforcementQueue(
            { driver: ctx.driver, db: ctx.db, logger: ctx.logger },
            {
              batchSize: ctx.config.hebbian.batchSize,
              learningRate: ctx.config.hebbian.learningRate,
              weightFloor: ctx.config.hebbian.weightFloor,
              now: ctx.now,
            },
          ),
        ctx.config.hebbian.flushCeiling,
        ctx.signal,
      );
      const stop = report.aborted ? ', stopped by shutdown' : '';
      return {
        status: report.signalsClaimed === 0 ? 'noop' : 'applied',
        itemsProcessed: report.signalsClaimed,
        itemsAffected: report.edgesUpdated,
        detail:
          `${String(report.pairsApplied)} pairs, ${String(report.edgesUpdated)} edges reinforced ` +
          `across ${String(report.batches)} batch(es)${stop}`,
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
      if (!ctx.config.maintenance.memoryDecay) {
        return {
          status: 'noop',
          itemsProcessed: 0,
          itemsAffected: 0,
          detail: 'decay disabled by AION_MAINTENANCE_MEMORY_DECAY; no edges scanned',
        };
      }
      const scanQuota = decayScanQuota(
        ctx.health.graph.decayableEdges,
        ctx.config.hebbian.decayScanFraction,
      );
      // The graph write takes a positive batch size; a snapshot with nothing decayable is a
      // noop the run must not turn into a call the write rejects. `relevance` already keeps
      // the engine from selecting this operation on such a snapshot, but a caller that runs
      // it directly (a test, a tier-3 recommendation) has no such guarantee.
      if (scanQuota === 0) {
        return {
          status: 'noop',
          itemsProcessed: 0,
          itemsAffected: 0,
          detail: 'no decayable edges reported by the snapshot',
        };
      }
      const report = await sweepEdgeDecay(
        { driver: ctx.driver, db: ctx.db, logger: ctx.logger },
        {
          batchSize: scanQuota,
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
