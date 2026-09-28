import type { Config } from '../../../infrastructure/config/schema.js';
import {
  addConsumeReports,
  consumeBatchWork,
  EMPTY_CONSUME,
  submitBatchWork,
  type BatchWorkHandler,
} from '../../../infrastructure/providers/batch-adapter.js';
import {
  PROVIDER_KEY_ENV_VARS,
  unavailableReason,
} from '../../../infrastructure/providers/routing.js';
import { GenerationSpendGuard } from '../../../infrastructure/providers/spending.js';
import {
  GENERATION_PROVIDERS,
  type GenerationProvider,
} from '../../../infrastructure/providers/types.js';
import {
  batchWorkCounts,
  discardPendingBatchWorkOf,
  outstandingBatchIds,
} from '../../../infrastructure/sqlite/batch-work.js';
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
 *
 * Each half follows a different provider rule. Submission sends only work encoded for the
 * provider the installation selects, with that provider's key. Consumption reads every job
 * through the provider that took it, with that provider's key, whatever is selected now: the
 * charge is committed and the answer is still owed. A job whose provider has no key left is not
 * read, not called complete, and not sent again as new work. The detail names it, and it settles
 * once that key is back. Owed work the other provider never received is discarded as the stale
 * question it is; a producer that asks it again reopens it for the selected provider.
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

/** A provider's key, trimmed the way its transport sends it, or undefined where none is set. */
function keyOf(config: Config, provider: GenerationProvider): string | undefined {
  const key = (provider === 'openai' ? config.openai.apiKey : config.anthropic.apiKey).trim();
  return key.length === 0 ? undefined : key;
}

export function batchSettlementOperation(
  handlers: readonly BatchWorkHandlerFactory[],
): IntrospectionOperation {
  return {
    name: BATCH_SETTLEMENT_OPERATION,
    bucket: 'quarter-hour',
    relevance: () => BATCH_SETTLEMENT_STANDING_RELEVANCE,
    run: async (ctx): Promise<OperationOutcome> => {
      const substrate = readSubstratePairing(ctx.db);
      if (substrate === undefined) {
        return {
          status: 'noop',
          itemsProcessed: 0,
          itemsAffected: 0,
          detail: 'no substrate identity, so no batch belongs to this store yet',
        };
      }
      const { substrateId } = substrate;
      const selected = ctx.config.generation.provider;

      const shared = {
        db: ctx.db,
        substrateId,
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
      let consumed = EMPTY_CONSUME;
      const unread: string[] = [];
      for (const provider of GENERATION_PROVIDERS) {
        if (outstandingBatchIds(ctx.db, substrateId, provider).length === 0) {
          continue;
        }
        const apiKey = keyOf(ctx.config, provider);
        if (apiKey === undefined) {
          const held = batchWorkCounts(ctx.db, substrateId, provider).submitted;
          const key = PROVIDER_KEY_ENV_VARS[provider];
          unread.push(`${String(held)} outstanding at ${provider} stay unread without ${key}`);
          continue;
        }
        consumed = addConsumeReports(
          consumed,
          await consumeBatchWork({ ...shared, provider, client: { apiKey } }),
        );
      }

      const selectedKey = keyOf(ctx.config, selected);
      const submitted =
        ctx.signal.aborted || selectedKey === undefined
          ? { submitted: 0, batchId: undefined }
          : await submitBatchWork({
              ...shared,
              provider: selected,
              client: { apiKey: selectedKey },
            });

      const counts = batchWorkCounts(ctx.db, substrateId);
      const notes = [...unread];
      if (selectedKey === undefined) {
        notes.push(`nothing submitted: ${unavailableReason({ provider: selected })}`);
      }
      for (const other of GENERATION_PROVIDERS.filter((provider) => provider !== selected)) {
        const dropped = discardPendingBatchWorkOf(
          ctx.db,
          substrateId,
          other,
          `encoded for ${other}, which the installation no longer selects`,
          ctx.now,
        );
        if (dropped > 0) {
          notes.push(
            `${String(dropped)} never-sent rows encoded for ${other} discarded; a producer that ` +
              `asks again re-encodes them for ${selected}`,
          );
        }
      }

      const touched = consumed.applied + consumed.discarded + consumed.returned + consumed.failed;
      return {
        status: touched === 0 && submitted.submitted === 0 ? 'noop' : 'applied',
        itemsProcessed: touched + submitted.submitted,
        itemsAffected: consumed.applied,
        detail:
          `${String(consumed.applied)} applied, ${String(consumed.discarded)} discarded as stale, ` +
          `${String(consumed.returned)} owed again, ${String(consumed.failed)} failed, ` +
          `${String(consumed.unrecognized)} unrecognized; ${String(submitted.submitted)} submitted ` +
          `to ${selected}; ${String(counts.pending)} pending and ${String(counts.submitted)} ` +
          `outstanding${notes.map((note) => `; ${note}`).join('')}`,
      };
    },
  };
}
