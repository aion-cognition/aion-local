import { boundApiCost } from './api-pricing.js';
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
 * replaces that as soon as the answer is in hand, which is what keeps a bound from locking up
 * headroom it never spent. A model the price table does not carry is bounded at the fallback card
 * rather than let through, so an unlisted model cannot spend a ceiling it is never measured on.
 *
 * Exhaustion is not an error condition anything retries. It is generation being unavailable, the
 * same shape as a substrate with no key, so background work queues and cues go raw.
 */

/**
 * The most one request can cost, in tokens, before it is sent.
 *
 * The input number is a maximum rather than a likely amount, and the request body in UTF-8 bytes
 * is what makes it one. The tokenizer works over bytes, so every token it produces covers at
 * least one byte of what was submitted, and the body's own JSON framing is longer than the role
 * markers the API wraps that text in. A count of characters divided by three is neither: it is an
 * average that a run of multi-byte text or dense punctuation passes straight through.
 *
 * The output number is `max_tokens`, which the API enforces rather than estimates.
 */
export function boundedTokens(
  requestBytes: number,
  maxTokens: number,
): { readonly inputTokens: number; readonly outputTokens: number } {
  return {
    inputTokens: Math.ceil(Math.max(0, requestBytes)),
    outputTokens: Math.max(0, maxTokens),
  };
}

export type SpendHoldRequest = {
  readonly surface: string;
  readonly model: string;
  readonly route: SpendRoute;
  /** The bound for the whole dispatch: one call, or every request in one batch. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  /**
   * Whether the request carries a cache marker. Only a marked prefix can be billed at the
   * cache-write rate, so only a marked request is held there. Absent reads as unmarked, which is
   * what every request this workspace builds is (`anthropic-cache.ts`).
   */
  readonly cacheWrite?: boolean;
  readonly now: Date;
};

export type SpendHold = {
  readonly reservationId: string;
  /** Dollars held: the bound the dispatch cannot cost more than. */
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
    const { maxUsd, priced } = boundApiCost({
      model: request.model,
      inputTokens: request.inputTokens,
      outputTokens: request.outputTokens,
      pricingTier: tierFor(request.route),
      cacheWrite: request.cacheWrite === true,
    });
    const outcome = reserveGenerationSpend(this.#db, {
      surface: request.surface,
      route: request.route,
      maxUsd,
      priced,
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
