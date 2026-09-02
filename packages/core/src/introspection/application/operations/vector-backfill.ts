import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import { findNeighborContentVectors } from '../../../infrastructure/graph/context-vector-queries.js';
import {
  findStaleContextVectorNodes,
  markContextVectorSynced,
  writeContextVectorSync,
} from '../../../infrastructure/graph/context-vector-sync.js';
import {
  attachContentVectors,
  findPendingVectorNodes,
} from '../../../reflection/application/vectors.js';
import { computeContextVectors } from '../../../reflection/domain/context-vector.js';
import type { HealthSnapshot } from '../../domain/health.js';
import type {
  IntrospectionOperation,
  OperationContext,
  OperationOutcome,
} from '../../domain/operation.js';

export const VECTOR_BACKFILL_OPERATION = 'vector_backfill';

/**
 * Two passes over the same population, one primary and one a tightly bounded addendum.
 *
 * The primary pass is the pending-vector drain: `:Memory` nodes committed without a
 * `content_vec`, or carrying one with no `content_vec_hash` to show it was taken over the
 * node's current text. Its relevance tracks the backlog directly (`vectorExpected` minus
 * `vectorPresent` is already in the snapshot, counted over the same predicate the drain
 * reads), which is what makes this operation preempt-worthy the moment vector search starts
 * missing nodes. Relevance divides by the shipped default rather than the live batch knob,
 * since the contract hands it only the health snapshot.
 *
 * The second pass has no backlog gauge of its own: a node's `context_vec` goes stale when a
 * neighbor's edge weight moves after reflection last computed it, and nothing in the health
 * snapshot counts how many nodes that has happened to. Rather than add a second relevance
 * driver for a gap with no urgency signal, this pass rides along on every selected run,
 * bounded small (`contextRefreshBatchSize`) so a quality touch-up never competes with the
 * backfill it shares a bucket with.
 */
export function vectorBackfillRelevance(health: HealthSnapshot): number {
  const pending = health.graph.vectorExpected - health.graph.vectorPresent;
  if (pending <= 0) {
    return 0;
  }
  return Math.min(1, pending / DEFAULTS.maintenance.vectorBackfillBatchSize);
}

async function backfillContentVectors(
  ctx: OperationContext,
): Promise<{ processed: number; affected: number }> {
  const pending = await findPendingVectorNodes(
    ctx.driver,
    ctx.config.maintenance.vectorBackfillBatchSize,
  );
  if (pending.length === 0) {
    return { processed: 0, affected: 0 };
  }
  const written = await attachContentVectors(ctx.driver, ctx.provider, pending);
  return { processed: pending.length, affected: written.length };
}

async function refreshContextVectors(
  ctx: OperationContext,
): Promise<{ processed: number; affected: number }> {
  const staleIds = await findStaleContextVectorNodes(
    ctx.driver,
    ctx.config.maintenance.contextRefreshBatchSize,
  );
  if (staleIds.length === 0) {
    return { processed: 0, affected: 0 };
  }
  const neighbors = await findNeighborContentVectors(ctx.driver, staleIds);
  const computed = computeContextVectors(neighbors);
  const written = await writeContextVectorSync(ctx.driver, computed, ctx.now);
  // A stale node the computation yields nothing for still counts as examined. The scan orders on
  // this stamp, so leaving it unwritten hands the same node back at the head of every later tick.
  const seen = new Set(written);
  await markContextVectorSynced(
    ctx.driver,
    staleIds.filter((id) => !seen.has(id)),
    ctx.now,
  );
  return { processed: staleIds.length, affected: written.length };
}

/**
 * It answers `vector_parity`, so a parity crisis selects it directly rather than making it
 * compete on urgency with a content touch-up. Below the critical threshold the same relevance
 * is scored routinely, which is the ordinary pending-vector drain.
 */
export function vectorBackfillOperation(): IntrospectionOperation {
  return {
    name: VECTOR_BACKFILL_OPERATION,
    answers: 'vector_parity',
    bucket: 'quarter-hour',
    relevance: vectorBackfillRelevance,
    measure: (health) => health.graph.vectorExpected - health.graph.vectorPresent,
    improves: 'lower',
    run: async (ctx): Promise<OperationOutcome> => {
      const content = await backfillContentVectors(ctx);
      const context = ctx.signal.aborted
        ? { processed: 0, affected: 0 }
        : await refreshContextVectors(ctx);

      const itemsProcessed = content.processed + context.processed;
      const itemsAffected = content.affected + context.affected;
      return {
        status: itemsAffected === 0 ? 'noop' : 'applied',
        itemsProcessed,
        itemsAffected,
        detail:
          `${String(content.affected)} of ${String(content.processed)} pending content vectors embedded, ` +
          `${String(context.affected)} of ${String(context.processed)} stale context vectors refreshed`,
      };
    },
  };
}
