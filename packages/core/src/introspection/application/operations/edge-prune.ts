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

/**
 * `GraphStructureHealth.decayableEdges` is one total across every unprotected relationship
 * type, association and typed-knowledge alike, so relevance cannot scale on the at-floor
 * `CO_OCCURS`/`SIMILAR` share the way `memoryDecayRelevance` scales on staleness: the snapshot
 * does not carry that narrower count. A standing value is the honest answer until it does.
 */
export const EDGE_PRUNE_STANDING_RELEVANCE = 0.15;

/**
 * Zero exactly when the coarser total already reads zero: association edges are a subset of
 * `decayableEdges`, so nothing unprotected at all means nothing prunable either. A positive
 * total does not guarantee a prunable edge exists, so the standing value beyond that gate is a
 * floor on urgency, not a measurement of how much at-floor mass is actually waiting.
 */
export function edgePruneRelevance(health: HealthSnapshot): number {
  if (health.graph.decayableEdges <= 0) {
    return 0;
  }
  return EDGE_PRUNE_STANDING_RELEVANCE;
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
    run: runEdgePrune,
  };
}
