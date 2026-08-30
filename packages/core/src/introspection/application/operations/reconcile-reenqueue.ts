import { reconcileEnrichment } from '../../../reflection/application/reconcile.js';
import type { HealthSnapshot } from '../../domain/health.js';
import type { IntrospectionOperation, OperationOutcome } from '../../domain/operation.js';

export const RECONCILE_REENQUEUE_OPERATION = 'reconcile_reenqueue';

/** Mirrors `maintenance.reconcileBatchSize`'s own default; see `defaults.ts` for why. */
const DEFAULT_RECONCILE_BATCH_SIZE = 200;

/**
 * Wraps `reconcileEnrichment`, the same call `aion doctor`'s `review-queue` check and the
 * operator's `aion queue reconcile` make, with `reEnqueue: true`. An episode with no
 * orchestrator ledger key and no queue row will never enrich on its own: nothing joins the
 * graph against the queue, so this is the one path that finds it.
 */
export function reconcileReenqueueRelevance(health: HealthSnapshot): number {
  return Math.min(1, health.enrichment.unenriched / DEFAULT_RECONCILE_BATCH_SIZE);
}

export function reconcileReenqueueOperation(): IntrospectionOperation {
  return {
    name: RECONCILE_REENQUEUE_OPERATION,
    bucket: 'hour',
    relevance: reconcileReenqueueRelevance,
    measure: (health) => health.enrichment.unenriched,
    improves: 'lower',
    run: async (ctx): Promise<OperationOutcome> => {
      const report = await reconcileEnrichment(ctx.driver, ctx.db, {
        limit: ctx.config.maintenance.reconcileBatchSize,
        reEnqueue: true,
      });
      return {
        status: report.reEnqueued === 0 ? 'noop' : 'applied',
        itemsProcessed: report.episodes,
        itemsAffected: report.reEnqueued,
        detail: `${String(report.reEnqueued)} of ${String(report.unenriched)} unenriched episodes re-enqueued`,
      };
    },
  };
}
