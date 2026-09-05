import {
  closeStaleIntentions,
  findStaleIntentions,
} from '../../../infrastructure/graph/intention-queries.js';
import { markLedgerApplied } from '../../../infrastructure/sqlite/ops-ledger.js';
import type {
  IntrospectionOperation,
  OperationContext,
  OperationOutcome,
} from '../../domain/operation.js';

/**
 * `intention_upkeep` closes the Goals and Plans nothing has restated in a long time.
 *
 * An intention is dated at write from its own episode's clock, and the read side already
 * down-ranks it and labels it expired once that date passes. That is the whole answer while the
 * intention is merely old: a plan a week past its horizon is still the last thing anyone said
 * about the plan. This operation is the second half, and it waits a whole further horizon
 * before acting, so what it closes is expired and stale rather than expired.
 *
 * The close is an ordinary bitemporal close carrying a stamp that names this operation, so
 * `aion unsupersede` reopens any intention it took, and a ledger row per close records which
 * ones it was. Nothing is deleted and nothing is forgotten: a forget is a person's act, and
 * `aion unsupersede` does not undo one.
 */

export const INTENTION_UPKEEP_OPERATION = 'intention_upkeep';

export const INTENTION_UPKEEP_LEDGER_PREFIX = 'intention_upkeep:';

/** Its own namespace, per closed intention, beside the engine's own bucket key for the run. */
export function intentionUpkeepLedgerKey(intentionId: string): string {
  return `${INTENTION_UPKEEP_LEDGER_PREFIX}${intentionId}`;
}

/**
 * Standing relevance, like `narrative_cleanup`: the health snapshot carries no count of
 * intentions past their horizon, so the operation reaches the urgency threshold on waiting time
 * alone. Low, because on most days the sweep reads a handful of rows and closes none of them.
 */
export const INTENTION_UPKEEP_STANDING_RELEVANCE = 0.1;

const DAY_MS = 24 * 60 * 60 * 1000;

async function runIntentionUpkeep(ctx: OperationContext): Promise<OperationOutcome> {
  if (!ctx.config.maintenance.intentionUpkeep) {
    return {
      status: 'noop',
      itemsProcessed: 0,
      itemsAffected: 0,
      detail:
        'intention upkeep disabled by AION_MAINTENANCE_INTENTION_UPKEEP; no intentions examined',
    };
  }

  const { intentionUpkeepBatch } = ctx.config.maintenance;
  // One horizon behind the clock. An intention whose own horizon fell after this mark is
  // expired and nothing more, which the read side is already saying.
  const staleBefore = new Date(
    ctx.now.getTime() - ctx.config.temporal.intentionHorizonDays * DAY_MS,
  );

  const stale = await findStaleIntentions(ctx.driver, staleBefore, intentionUpkeepBatch);
  if (stale.length === 0) {
    return {
      status: 'noop',
      itemsProcessed: 0,
      itemsAffected: 0,
      detail: 'no intention has been past its horizon for a whole horizon',
    };
  }

  // The scan's own test is re-derived inside the write, so an intention restated between the
  // read and the write keeps the fresh horizon it just earned and stays open.
  const closed = await closeStaleIntentions(
    ctx.driver,
    stale.map((intention) => intention.id),
    ctx.now,
    staleBefore,
  );

  const horizons = new Map(stale.map((intention) => [intention.id, intention.validHorizon]));
  for (const id of closed) {
    markLedgerApplied(ctx.db, intentionUpkeepLedgerKey(id), {
      closedAt: ctx.now.toISOString(),
      validHorizon: horizons.get(id)?.toISOString(),
    });
  }

  return {
    status: closed.length === 0 ? 'noop' : 'applied',
    itemsProcessed: stale.length,
    itemsAffected: closed.length,
    detail:
      `closed ${String(closed.length)} of ${String(stale.length)} intention(s) ` +
      'past their horizon by a whole horizon',
  };
}

export function intentionUpkeepOperation(): IntrospectionOperation {
  return {
    name: INTENTION_UPKEEP_OPERATION,
    bucket: 'day',
    enabled: (config) => config.maintenance.intentionUpkeep,
    relevance: () => INTENTION_UPKEEP_STANDING_RELEVANCE,
    run: runIntentionUpkeep,
  };
}
