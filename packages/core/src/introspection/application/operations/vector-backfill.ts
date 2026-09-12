import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import { findStaleContextVectorNodes } from '../../../infrastructure/graph/context-vector-sync.js';
import { publishContextVectorSync } from '../../../reflection/application/context-vector-sync.js';
import {
  attachContentVectors,
  findPendingVectorNodes,
} from '../../../reflection/application/vectors.js';
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

type RefreshTally = { processed: number; affected: number; refusal?: string };

/**
 * The staleness scan nominates; `context_vector_sync` writes.
 *
 * The scan's own answer used to be stamped whatever it found, on the argument that a node left
 * unstamped comes back at the head of every later tick. That argument still holds and the
 * operation still stamps for it — but only over a neighbourhood the guard could read whole. A
 * node whose neighbours have no embeddings yet is now a named hold rather than a stamp, because
 * stamping it would take it out of the scan's ordering before anything computed its context, and
 * no edge has to move for its neighbour's vector to arrive.
 */
async function refreshContextVectors(ctx: OperationContext): Promise<RefreshTally> {
  const publications = ctx.narratives?.publications;
  if (publications === undefined) {
    return { processed: 0, affected: 0, refusal: 'no publication coordinator composed' };
  }
  const staleIds = await findStaleContextVectorNodes(
    ctx.driver,
    ctx.config.maintenance.contextRefreshBatchSize,
  );
  if (staleIds.length === 0) {
    return { processed: 0, affected: 0 };
  }
  const outcome = await publishContextVectorSync(
    { driver: ctx.driver, db: ctx.db, publications, now: ctx.now },
    {
      basis: 'staleness_scan',
      // No one subject: the scan's population is whatever fell behind, across every session.
      subject: null,
      members: staleIds.map((id) => ({ id, workId: null })),
    },
  );
  if (outcome.status !== 'published') {
    return { processed: staleIds.length, affected: 0, refusal: outcome.reason };
  }
  const { recomputed, cleared, stamped } = outcome.result;
  return {
    processed: staleIds.length,
    affected: recomputed.length + cleared.length + stamped.length,
  };
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
      const refused =
        context.refusal === undefined
          ? ''
          : ` (the context pass published nothing: ${context.refusal})`;
      return {
        status: itemsAffected === 0 ? 'noop' : 'applied',
        itemsProcessed,
        itemsAffected,
        detail:
          `${String(content.affected)} of ${String(content.processed)} pending content vectors embedded, ` +
          `${String(context.affected)} of ${String(context.processed)} stale context vectors refreshed${refused}`,
      };
    },
  };
}
