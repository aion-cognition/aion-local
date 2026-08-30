import { findNeighborContentVectors } from '../../../infrastructure/graph/context-vector-queries.js';
import {
  findStaleContextVectorNodes,
  writeContextVectorSync,
} from '../../../infrastructure/graph/context-vector-sync.js';
import { OllamaProvider } from '../../../infrastructure/providers/ollama-provider.js';
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

/** Mirrors `maintenance.vectorBackfillBatchSize`'s own default; see `defaults.ts` for why. */
const DEFAULT_VECTOR_BACKFILL_BATCH_SIZE = 100;

/**
 * Two passes over the same population, one primary and one a tightly bounded addendum.
 *
 * The primary pass is the pending-vector drain: `:Memory` nodes committed without a
 * `content_vec` because intake writes before it embeds. Its relevance tracks the backlog
 * directly (`vectorExpected` minus `vectorPresent` is already in the snapshot), which is
 * what makes this operation preempt-worthy the moment vector search starts missing nodes.
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
  return Math.min(1, pending / DEFAULT_VECTOR_BACKFILL_BATCH_SIZE);
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
  const provider = new OllamaProvider({
    baseUrl: ctx.config.ollama.url,
    embedModel: ctx.config.models.embed,
  });
  const written = await attachContentVectors(ctx.driver, provider, pending);
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
