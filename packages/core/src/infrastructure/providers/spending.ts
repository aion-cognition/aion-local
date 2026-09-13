import { estimateApiCost } from './api-pricing.js';
import { GenerationCeilingReachedError } from './errors.js';
import type { ApiPricingTier } from './types.js';
import type { SqliteHandle } from '../sqlite/database.js';
import {
  readSpendDay,
  releaseGenerationSpend,
  reserveGenerationSpend,
  settleGenerationSpend,
  type SpendDayTotals,
  type SpendRoute,
} from '../sqlite/spend-ledger.js';

/**
 * The daily spending backstop, consulted before a request leaves the machine.
 *
 * Both routes hold against the same day's ceiling: an ordinary Messages call and a batch
 * submission compete for the same dollars, so a substrate cannot stay under the number on each
 * route and over it in total. The hold is the most the dispatch can cost; what it actually cost
 * replaces that as soon as the answer is in hand, which is what keeps a conservative estimate
 * from locking up headroom it never spent.
 *
 * Exhaustion is not an error condition anything retries. It is generation being unavailable, the
 * same shape as a substrate with no key, so background work queues and cues go raw.
 */

/**
 * Characters per token for the input estimate. Deliberately under the four the pricing docs
 * estimate: the hold has to sit above the bill rather than under it, and the reconcile a moment
 * later is what takes the slack back.
 */
export const CONSERVATIVE_CHARS_PER_TOKEN = 3;

/**
 * The most one request can cost, in tokens, before it is sent.
 *
 * Priced as ordinary input, which is the cheapest of the three input classes. The margin covers
 * the gap: a prompt billed entirely as a cache write costs 1.25 times ordinary input, and the
 * estimate above already reads a prompt as 1.33 times the tokens it is likely to be. No shipped
 * prefix reaches the cache floor either way (`prompt-prefix-size.test.ts`).
 */
export function conservativeTokens(
  promptChars: number,
  maxTokens: number,
): { readonly inputTokens: number; readonly outputTokens: number } {
  return {
    inputTokens: Math.ceil(Math.max(0, promptChars) / CONSERVATIVE_CHARS_PER_TOKEN),
    outputTokens: Math.max(0, maxTokens),
  };
}

export type SpendHoldRequest = {
  readonly surface: string;
  readonly model: string;
  readonly route: SpendRoute;
  /** The conservative bound for the whole dispatch: one call, or every request in one batch. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly now: Date;
};

export type SpendHold = {
  readonly reservationId: string;
  /** Dollars held. Zero where the model carries no price, which no ceiling can bound. */
  readonly reservedUsd: number;
  /** What the answer cost, replacing the hold. `undefined` keeps the hold: unknown is not free. */
  settle(usd: number | undefined, now?: Date): void;
  /** The request never reached the wire. */
  release(now?: Date): void;
};

export type SpendingGuard = {
  /**
   * Holds the dispatch's maximum against the day, or answers with the refusal to throw. The
   * caller throws it, because only the caller knows whether it is inside a promise the pipeline
   * is awaiting or on a queue pump that logs and returns.
   */
  hold(request: SpendHoldRequest): { hold: SpendHold } | { refused: GenerationCeilingReachedError };
  /** What the day has committed, for a report. */
  today(now?: Date): SpendDayTotals;
};

function tierFor(route: SpendRoute): ApiPricingTier {
  if (route === 'batch') {
    return 'batch';
  }
  return 'standard';
}

export type GenerationSpendGuardOptions = {
  readonly db: SqliteHandle;
  /** Dollars of generation one UTC day may commit. */
  readonly ceilingUsd: number;
};

/**
 * The guard over one substrate's store. It holds no state of its own: every reservation is a row,
 * so two callers in one process, two processes, and one process across a restart all read the
 * same committed total.
 */
export class GenerationSpendGuard implements SpendingGuard {
  readonly #db: SqliteHandle;
  readonly #ceilingUsd: number;

  constructor(options: GenerationSpendGuardOptions) {
    this.#db = options.db;
    this.#ceilingUsd = options.ceilingUsd;
  }

  hold(
    request: SpendHoldRequest,
  ): { hold: SpendHold } | { refused: GenerationCeilingReachedError } {
    const maxUsd = estimateApiCost({
      model: request.model,
      inputTokens: request.inputTokens,
      outputTokens: request.outputTokens,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      pricingTier: tierFor(request.route),
    });
    const outcome = reserveGenerationSpend(this.#db, {
      surface: request.surface,
      route: request.route,
      maxUsd,
      ceilingUsd: this.#ceilingUsd,
      now: request.now,
    });
    if (!outcome.ok) {
      return {
        refused: new GenerationCeilingReachedError(
          request.surface,
          outcome.totals.committedUsd,
          this.#ceilingUsd,
        ),
      };
    }
    const { reservationId, reservedUsd } = outcome.reservation;
    const db = this.#db;
    return {
      hold: {
        reservationId,
        reservedUsd,
        settle: (usd: number | undefined, now: Date = new Date()): void => {
          settleGenerationSpend(db, reservationId, usd, now);
        },
        release: (now: Date = new Date()): void => {
          releaseGenerationSpend(db, reservationId, now);
        },
      },
    };
  }

  today(now: Date = new Date()): SpendDayTotals {
    return readSpendDay(this.#db, now);
  }
}
