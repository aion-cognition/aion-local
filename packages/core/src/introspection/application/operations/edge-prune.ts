import {
  closeEligibleAssociationEdges,
  countEdgesByFloorBand,
} from '../../../infrastructure/graph/edge-prune-queries.js';
import type { HealthSnapshot } from '../../domain/health.js';
import type {
  IntrospectionOperation,
  OperationContext,
  OperationOutcome,
} from '../../domain/operation.js';

/**
 * `edge_prune` closes `CO_OCCURS`/`SIMILAR` edges the decay sweep has driven to the floor and
 * nothing has reinforced in `edgePruneUnreinforcedDays`. See
 * `edge-prune-queries.ts` for why this scope and why closing rather than deleting; this file is
 * only the adapter to the maintenance-operation contract, the same split decay and
 * reinforcement already follow.
 *
 * Acts from day one, gated by the `edgePrune` kill switch: off leaves every at-floor edge in
 * place, exactly as decay left it before this operation existed.
 */

export const EDGE_PRUNE_OPERATION = 'edge_prune';

/** How much at-floor association mass reads as a full call for a run. */
export const EDGE_PRUNE_RELEVANCE_DIVISOR = 1_000;

/**
 * Scaled on the at-floor count the snapshot now carries, which is exactly the population a run
 * closes: zero at-floor edges is zero relevance, and everything above that scales the way
 * `memoryDecayRelevance` scales on staleness rather than standing at a fixed value.
 */
export function edgePruneRelevance(health: HealthSnapshot): number {
  return Math.min(1, health.graph.atFloorAssociationEdges / EDGE_PRUNE_RELEVANCE_DIVISOR);
}

async function runEdgePrune(ctx: OperationContext): Promise<OperationOutcome> {
  if (!ctx.config.maintenance.edgePrune) {
    return {
      status: 'noop',
      itemsProcessed: 0,
      itemsAffected: 0,
      detail: 'edge pruning disabled by AION_MAINTENANCE_EDGE_PRUNE; no edges examined',
    };
  }

  const { weightFloor } = ctx.config.hebbian;
  const before = await countEdgesByFloorBand(ctx.driver, weightFloor);
  const closed = await closeEligibleAssociationEdges(ctx.driver, {
    batchSize: ctx.config.maintenance.edgePruneBatch,
    weightFloor,
    unreinforcedDays: ctx.config.maintenance.edgePruneUnreinforcedDays,
    now: ctx.now,
  });
  const after = await countEdgesByFloorBand(ctx.driver, weightFloor);

  return {
    status: closed.length === 0 ? 'noop' : 'applied',
    itemsProcessed: closed.length,
    itemsAffected: closed.length,
    detail:
      `closed ${String(closed.length)} at-floor CO_OCCURS/SIMILAR edge(s); ` +
      `at-floor ${String(before.atFloor)}->${String(after.atFloor)}, ` +
      `above-floor ${String(before.aboveFloor)}->${String(after.aboveFloor)}`,
  };
}

/**
 * `edgePruneBatch` defaults to 1000: the roughly four thousand `CO_OCCURS`/`SIMILAR` edges
 * already sitting at the floor on the live substrate clear in about four days at one run per
 * day, the `day` bucket below.
 */
export function edgePruneOperation(): IntrospectionOperation {
  return {
    name: EDGE_PRUNE_OPERATION,
    bucket: 'day',
    relevance: edgePruneRelevance,
    // The count a run closes from, so a run that closed nothing cannot read as a success. New
    // decay can drive fresh edges to the floor between two ticks, which is why the score is
    // whether the count fell rather than whether the run closed anything.
    measure: (health) => health.graph.atFloorAssociationEdges,
    improves: 'lower',
    run: runEdgePrune,
  };
}
