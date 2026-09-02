import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import {
  DEFAULT_RECONCILE_LIMIT,
  reconcileEnrichment,
} from '../../../reflection/application/reconcile.js';
import type { HealthSnapshot } from '../../domain/health.js';
import type { IntrospectionOperation, OperationOutcome } from '../../domain/operation.js';

export const RECONCILE_REENQUEUE_OPERATION = 'reconcile_reenqueue';

/**
 * Wraps `reconcileEnrichment`, the same call `aion doctor`'s `review-queue` check and the
 * operator's `aion queue reconcile` make, with `reEnqueue: true`. An episode with no
 * orchestrator ledger key and no queue row will never enrich on its own: nothing joins the
 * graph against the queue, so this is the one path that finds it.
 *
 * Relevance reads the shipped default rather than the live config: the contract hands it only
 * the health snapshot, so a knob an operator retuned changes what a run drains and not how
 * urgently the loop wants one.
 */
export function reconcileReenqueueRelevance(health: HealthSnapshot): number {
  return Math.min(1, health.enrichment.unenriched / DEFAULTS.maintenance.reconcileBatchSize);
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
        // The scan matches the one the health snapshot takes, so the operation can reach every
        // episode the metric it is scored on counts. Only the write is batched.
        limit: DEFAULT_RECONCILE_LIMIT,
        reEnqueue: true,
        reEnqueueLimit: ctx.config.maintenance.reconcileBatchSize,
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
