import { findEpisodesMissingSessionLink } from '../../../infrastructure/graph/backbone-repair-queries.js';
import { upsertEdge } from '../../../infrastructure/graph/edges.js';
import { CONTAINMENT_TYPE } from '../../../infrastructure/graph/episodes.js';
import { criticalConditions, type HealthSnapshot } from '../../domain/health.js';
import type {
  IntrospectionOperation,
  OperationContext,
  OperationOutcome,
} from '../../domain/operation.js';

/**
 * Emergency relationship repair: the missing backbone link between an episode and its session.
 *
 * This is the responder for the one critical condition the loop could name and could not
 * answer. An episode with no `PARTICIPATES_IN` edge to its session is unreachable from the
 * session narrative, from the context vectors, and from every traversal that starts at a
 * session, so the substrate holds it and recall cannot find it.
 *
 * The repair is a lookup, not an inference. The episode carries `session_id` from intake, and
 * the edge is rewritten exactly as intake writes it, with its own provenance so a person
 * reading the graph months later can tell a repaired link from an original one. An episode
 * whose `session_id` names no current session is left alone: there is nothing to attach it to.
 */

export const BACKBONE_REPAIR_OPERATION = 'emergency_relationship_repair';

export const BACKBONE_REPAIR_SIGNAL = 'backbone_repair';
export const BACKBONE_REPAIR_PROVENANCE = 'introspection';

/** Mirrors `maintenance.backboneRepairBatch`'s own default; see `defaults.ts` for why. */
const DEFAULT_BACKBONE_REPAIR_BATCH = 200;

export function backboneRepairRelevance(health: HealthSnapshot): number {
  if (!criticalConditions(health).includes('missing_backbone_links')) {
    return 0;
  }
  return Math.min(1, health.graph.episodesWithoutSession / DEFAULT_BACKBONE_REPAIR_BATCH);
}

async function runBackboneRepair(ctx: OperationContext): Promise<OperationOutcome> {
  const targets = await findEpisodesMissingSessionLink(
    ctx.driver,
    ctx.config.maintenance.backboneRepairBatch,
  );
  if (targets.length === 0) {
    // The count is above zero and nothing in the batch is repairable, which means every break
    // in scope names a session the graph no longer holds. Saying so is the honest answer;
    // deciding what such an episode belongs to is a person's call.
    return {
      status: 'noop',
      itemsProcessed: 0,
      itemsAffected: 0,
      detail: 'no episode in scope names a session that still exists',
    };
  }

  let repaired = 0;
  for (const target of targets) {
    if (ctx.signal.aborted) {
      break;
    }
    await upsertEdge(ctx.driver, {
      type: CONTAINMENT_TYPE,
      sourceId: target.episodeId,
      targetId: target.sessionId,
      strength: 1,
      confidence: 1,
      signals: [BACKBONE_REPAIR_SIGNAL],
      provenance: [BACKBONE_REPAIR_PROVENANCE],
      // Structural, so a second run adds nothing to the count.
      count: 0,
      rationale: 'restored the containment link the episode already named',
      now: ctx.now,
    });
    repaired += 1;
  }

  return {
    status: repaired === 0 ? 'noop' : 'applied',
    itemsProcessed: targets.length,
    itemsAffected: repaired,
    detail: `${String(repaired)} of ${String(targets.length)} episodes relinked to their session`,
  };
}

export function backboneRepairOperation(): IntrospectionOperation {
  return {
    name: BACKBONE_REPAIR_OPERATION,
    answers: 'missing_backbone_links',
    bucket: 'quarter-hour',
    relevance: backboneRepairRelevance,
    measure: (health) => health.graph.episodesWithoutSession,
    improves: 'lower',
    run: runBackboneRepair,
  };
}
