import type { SqliteHandle } from './database.js';
import type { Logger } from '../logging/logger.js';
import { estimateApiCost } from '../providers/api-pricing.js';
import type { ApiCall, ApiPricingTier } from '../providers/types.js';

/**
 * Each paid response is a new event, even when its request repeats an earlier one.
 *
 * A call carrying a remote request identity is the exception, and it is not the same thing: the
 * identity names one paid response, and a route that reads its answers back (the batch pump reads
 * an ended batch on every pass until its rows are settled) hands the same response over again.
 * True where this write recorded a charge, false where the identity was already on the books.
 */
export function appendApiCall(db: SqliteHandle, call: ApiCall): boolean {
  const result = db
    .prepare(
      `INSERT INTO api_calls (
    occurred_at, model, surface, input_tokens, output_tokens, cache_creation_tokens,
    cache_creation_5m_tokens, cache_creation_1h_tokens,
    cache_read_tokens, thinking_tokens, duration_ms, attempts, usage_error, request_id,
    pricing_tier
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(request_id) DO NOTHING`,
    )
    .run(
      call.occurredAt.toISOString(),
      call.model,
      call.surface,
      call.inputTokens,
      call.outputTokens,
      call.cacheCreationTokens,
      // Stored apart from the aggregate, because the two write classes are priced apart. A row
      // that dropped them prices an hour-long write at the five-minute rate the moment the
      // in-memory call is gone, which is every reading `aion costs` and batch settlement make.
      call.cacheCreation5mTokens ?? null,
      call.cacheCreation1hTokens ?? null,
      call.cacheReadTokens,
      call.thinkingTokens ?? null,
      call.durationMs,
      call.attempts,
      call.usageError ?? null,
      call.requestId ?? null,
      call.pricingTier ?? 'standard',
    );
  return result.changes > 0;
}

/** Storage failures must be visible without turning a paid response into another paid retry. */
export class ApiUsageRecorder {
  readonly #db: SqliteHandle;
  readonly #logger: Pick<Logger, 'warn' | 'error'>;

  constructor(db: SqliteHandle, logger: Pick<Logger, 'warn' | 'error'>) {
    this.#db = db;
    this.#logger = logger;
  }

  readonly recordApiCall = (call: ApiCall): void => {
    try {
      if (call.usageError !== undefined) {
        this.#logger.error(
          { model: call.model, surface: call.surface, usageError: call.usageError },
          'API usage parse failed; billed token counts are unknown',
        );
      }
      appendApiCall(this.#db, call);
    } catch (err) {
      this.#logger.warn(
        { err, model: call.model, surface: call.surface },
        'API usage write failed',
      );
    }
  };
}

export type ApiUsageGroup = {
  readonly key: string;
  readonly model: string;
  /** Kept out of the model group rather than folded into it: one rate card per group, or none. */
  readonly pricingTier: ApiPricingTier;
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationTokens: number;
  /**
   * The five-minute and hour-long shares of `cacheCreationTokens`, inside that total rather than
   * beside it. Absent where no call in the group reported a breakdown, which prices the whole
   * aggregate at the five-minute rate; where some did and some did not, the part neither share
   * covers is the unreported remainder and prices the same way.
   */
  readonly cacheCreation5mTokens?: number;
  readonly cacheCreation1hTokens?: number;
  readonly cacheReadTokens: number;
  /**
   * Part of `outputTokens`, never an addition to it: a total that sums both double-counts. Null
   * where no call in the group reported a breakdown, since summing nothing is not zero.
   */
  readonly thinkingTokens: number | null;
  /** Calls in the group whose reasoning share was never reported, so the sum above is partial. */
  readonly thinkingUnknown: number;
  readonly durationMs: number;
  readonly attempts: number;
  readonly usageErrors: number;
};

export type ApiUsageSummary = {
  readonly days: readonly ApiUsageGroup[];
  readonly surfaces: readonly ApiUsageGroup[];
};

function groupedUsage(
  db: SqliteHandle,
  dimension: 'day' | 'surface',
  since: Date,
  until: Date,
): ApiUsageGroup[] {
  const key = dimension === 'day' ? 'substr(occurred_at, 1, 10)' : 'surface';
  const rows = db
    .prepare(
      `SELECT ${key} AS key, model, pricing_tier AS pricingTier, count(*) AS calls,
    sum(input_tokens) AS inputTokens, sum(output_tokens) AS outputTokens,
    sum(cache_creation_tokens) AS cacheCreationTokens,
    sum(cache_creation_5m_tokens) AS cacheCreation5mTokens,
    sum(cache_creation_1h_tokens) AS cacheCreation1hTokens,
    sum(cache_read_tokens) AS cacheReadTokens,
    sum(thinking_tokens) AS thinkingTokens,
    sum(CASE WHEN thinking_tokens IS NULL THEN 1 ELSE 0 END) AS thinkingUnknown,
    sum(duration_ms) AS durationMs, sum(attempts) AS attempts,
    sum(CASE WHEN usage_error IS NOT NULL THEN 1 ELSE 0 END) AS usageErrors
    FROM api_calls WHERE occurred_at >= ? AND occurred_at < ?
    GROUP BY ${key}, model, pricing_tier ORDER BY key, model, pricing_tier`,
    )
    .all(since.toISOString(), until.toISOString()) as (Omit<
    ApiUsageGroup,
    'cacheCreation5mTokens' | 'cacheCreation1hTokens'
  > & {
    cacheCreation5mTokens: number | null;
    cacheCreation1hTokens: number | null;
  })[];
  // `sum` over rows that all reported nothing answers null, and that null is the fact: this
  // group's writes carry no reported split. Kept off the row rather than carried as a zero, which
  // would price an unreported hour-long write at the five-minute rate.
  return rows.map(({ cacheCreation5mTokens, cacheCreation1hTokens, ...row }) => ({
    ...row,
    ...(cacheCreation5mTokens === null ? {} : { cacheCreation5mTokens }),
    ...(cacheCreation1hTokens === null ? {} : { cacheCreation1hTokens }),
  }));
}

/**
 * Dates are UTC; model groups remain separate so an unknown model cannot inherit a price, and
 * rate cards remain separate so a batched answer cannot inherit the ordinary one.
 */
export function summarizeApiCalls(db: SqliteHandle, since: Date, until: Date): ApiUsageSummary {
  return db.transaction(() => ({
    days: groupedUsage(db, 'day', since, until),
    surfaces: groupedUsage(db, 'surface', since, until),
  }))();
}

/**
 * Which of these remote request identities carry no charge on the books.
 *
 * A usage write can fail on its own: the response arrived, the answer was used, and the row that
 * prices it did not land. Summing the rows that did land cannot see that, so the identities the
 * caller knows were answered are checked against the books by name. An identity already on the
 * books is accounted for however it got there, which is what makes a re-read of an ended batch
 * complete rather than a duplicate.
 */
export function unaccountedApiRequests(
  db: SqliteHandle,
  requestIds: readonly string[],
): readonly string[] {
  if (requestIds.length === 0) {
    return [];
  }
  const placeholders = requestIds.map(() => '?').join(', ');
  const rows = db
    .prepare(`SELECT request_id FROM api_calls WHERE request_id IN (${placeholders})`)
    .all(...requestIds) as { request_id: string }[];
  const recorded = new Set(rows.map((row) => row.request_id));
  return requestIds.filter((requestId) => !recorded.has(requestId));
}

/**
 * What one remote batch has been charged so far, read from the calls recorded under its own
 * request identities.
 *
 * The spending hold a submission took is reconciled against this rather than against a running
 * total the pump keeps: the rows are deduplicated by request identity, so re-reading an ended
 * batch recomputes the same number instead of adding to it.
 *
 * `undefined` where any of it is unpriced or unreadable. The caller leaves the hold at its
 * maximum in that case, which is the only honest reading of a charge nobody can size.
 */
export function chargedApiUsd(db: SqliteHandle, batchId: string): number | undefined {
  const rows = db
    .prepare(
      `SELECT model, pricing_tier AS pricingTier,
    sum(input_tokens) AS inputTokens, sum(output_tokens) AS outputTokens,
    sum(cache_creation_tokens) AS cacheCreationTokens,
    sum(cache_creation_5m_tokens) AS cacheCreation5mTokens,
    sum(cache_creation_1h_tokens) AS cacheCreation1hTokens,
    sum(cache_read_tokens) AS cacheReadTokens,
    sum(CASE WHEN usage_error IS NOT NULL THEN 1 ELSE 0 END) AS usageErrors
    FROM api_calls WHERE request_id LIKE ? ESCAPE '\\'
    GROUP BY model, pricing_tier`,
    )
    .all(`${batchId.replace(/[\\%_]/g, '\\$&')}:%`) as (Pick<
    ApiCall,
    'model' | 'inputTokens' | 'outputTokens' | 'cacheCreationTokens' | 'cacheReadTokens'
  > & {
    pricingTier: ApiPricingTier;
    cacheCreation5mTokens: number | null;
    cacheCreation1hTokens: number | null;
    usageErrors: number;
  })[];
  let total = 0;
  for (const row of rows) {
    // The split travels into the estimate for the reason it is stored at all: settling a batch
    // that wrote for the hour at the five-minute rate reports the lane cheaper than the bill.
    const { cacheCreation5mTokens, cacheCreation1hTokens, ...totals } = row;
    const priced = {
      ...totals,
      ...(cacheCreation5mTokens === null ? {} : { cacheCreation5mTokens }),
      ...(cacheCreation1hTokens === null ? {} : { cacheCreation1hTokens }),
    };
    const cost = row.usageErrors > 0 ? undefined : estimateApiCost(priced);
    if (cost === undefined) {
      return undefined;
    }
    total += cost;
  }
  return total;
}
