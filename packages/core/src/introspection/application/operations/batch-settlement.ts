import {
  consumeBatchWork,
  submitBatchWork,
  type BatchWorkHandler,
} from '../../../infrastructure/providers/batch-adapter.js';
import { GenerationSpendGuard } from '../../../infrastructure/providers/spending.js';
import { batchWorkCounts } from '../../../infrastructure/sqlite/batch-work.js';
import { readSubstratePairing } from '../../../infrastructure/sqlite/publication-control.js';
import type {
  IntrospectionOperation,
  OperationContext,
  OperationOutcome,
} from '../../domain/operation.js';

/**
 * The pump behind batched generation: send what is owed, read back what has landed.
 *
 * It runs on the maintenance tick rather than on a timer of its own because that is the cadence
 * the work was batched for. A batch takes minutes to hours, so polling it faster buys nothing
 * and polling it slower is the only cost of missing a tick. What that means in practice is the
 * engine's own policy and not a promise of a quarter-hour: one operation runs per tick, chosen
 * from the whole catalog by tier, urgency and waiting time, and this one carries a standing
 * relevance it reaches the threshold on through starvation rather than through demand. The
 * quarter-hour bucket is a ceiling on how often it may be chosen, not a floor on how often it is.
 *
 * Both halves are bounded and neither waits: submission sends one batch and returns, and
 * consumption reads the jobs that have ended and leaves the rest outstanding. Nothing here holds
 * the publication guard; a handler that publishes takes its own when the answer is in hand.
 */

/**
 * A handler, built from the run's own context.
 *
 * The handler applies an answer hours after the request was built, which means writing to the
 * graph and embedding through the same provider the loop uses. Neither is available where the
 * catalog is composed, so the catalog registers the factory and the run supplies the context, the
 * same way every other operation reaches the driver.
 */
export type BatchWorkHandlerFactory = (ctx: OperationContext) => BatchWorkHandler;

export const BATCH_SETTLEMENT_OPERATION = 'batch_settlement';

/**
 * A floor, not a reading. Outstanding batch work has no gauge in the health snapshot, so this
 * never reaches the urgency threshold on its own and the engine's starvation boost carries it.
 */
export const BATCH_SETTLEMENT_STANDING_RELEVANCE = 0.15;

export function batchSettlementOperation(
  handlers: readonly BatchWorkHandlerFactory[],
): IntrospectionOperation {
  return {
    name: BATCH_SETTLEMENT_OPERATION,
    bucket: 'quarter-hour',
    relevance: () => BATCH_SETTLEMENT_STANDING_RELEVANCE,
    run: async (ctx): Promise<OperationOutcome> => {
      const apiKey = ctx.config.anthropic.apiKey.trim();
      if (apiKey.length === 0) {
        return {
          status: 'noop',
          itemsProcessed: 0,
          itemsAffected: 0,
          detail: 'no API key, so batched work stays queued',
        };
      }
      const substrate = readSubstratePairing(ctx.db);
      if (substrate === undefined) {
        return {
          status: 'noop',
          itemsProcessed: 0,
          itemsAffected: 0,
          detail: 'no substrate identity, so no batch belongs to this store yet',
        };
      }

      const deps = {
        db: ctx.db,
        substrateId: substrate.substrateId,
        client: { apiKey },
        handlers: handlers.map((handler) => handler(ctx)),
        logger: ctx.logger,
        // The same day's ceiling the ordinary route holds against. A submission it cannot cover
        // is not sent and the work stays queued, which is what a background lane is for.
        spending: new GenerationSpendGuard({
          db: ctx.db,
          ceilingUsd: ctx.config.anthropic.dailyCeilingUsd,
        }),
        now: () => ctx.now,
      };

      // Consume first. An answer already in hand is worth more than a request not yet sent, and
      // a tick the signal cuts short leaves the sending rather than the settling undone.
      const consumed = await consumeBatchWork(deps);
      const submitted = ctx.signal.aborted
        ? { submitted: 0, batchId: undefined }
        : await submitBatchWork(deps);
      const counts = batchWorkCounts(ctx.db, substrate.substrateId);

      const touched = consumed.applied + consumed.discarded + consumed.returned + consumed.failed;
      return {
        status: touched === 0 && submitted.submitted === 0 ? 'noop' : 'applied',
        itemsProcessed: touched + submitted.submitted,
        itemsAffected: consumed.applied,
        detail:
          `${String(consumed.applied)} applied, ${String(consumed.discarded)} discarded as stale, ` +
          `${String(consumed.returned)} owed again, ${String(consumed.failed)} failed, ` +
          `${String(consumed.unrecognized)} unrecognized; ${String(submitted.submitted)} submitted; ` +
          `${String(counts.pending)} pending and ${String(counts.submitted)} outstanding`,
      };
    },
  };
}
