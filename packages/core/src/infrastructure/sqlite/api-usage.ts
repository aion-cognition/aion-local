import type { SqliteHandle } from './database.js';
import type { Logger } from '../logging/logger.js';
import type { ApiCall } from '../providers/types.js';

/** Each paid response is a new event, even when its request repeats an earlier one. */
export function appendApiCall(db: SqliteHandle, call: ApiCall): void {
  db.prepare(
    `INSERT INTO api_calls (
    occurred_at, model, surface, input_tokens, output_tokens, cache_creation_tokens,
    cache_read_tokens, duration_ms, attempts, usage_error
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    call.occurredAt.toISOString(),
    call.model,
    call.surface,
    call.inputTokens,
    call.outputTokens,
    call.cacheCreationTokens,
    call.cacheReadTokens,
    call.durationMs,
    call.attempts,
    call.usageError ?? null,
  );
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
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationTokens: number;
  readonly cacheReadTokens: number;
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
  return db
    .prepare(
      `SELECT ${key} AS key, model, count(*) AS calls,
    sum(input_tokens) AS inputTokens, sum(output_tokens) AS outputTokens,
    sum(cache_creation_tokens) AS cacheCreationTokens, sum(cache_read_tokens) AS cacheReadTokens,
    sum(duration_ms) AS durationMs, sum(attempts) AS attempts,
    sum(CASE WHEN usage_error IS NOT NULL THEN 1 ELSE 0 END) AS usageErrors
    FROM api_calls WHERE occurred_at >= ? AND occurred_at < ?
    GROUP BY ${key}, model ORDER BY key, model`,
    )
    .all(since.toISOString(), until.toISOString()) as ApiUsageGroup[];
}

/** Dates are UTC; model groups remain separate so an unknown model cannot inherit a price. */
export function summarizeApiCalls(db: SqliteHandle, since: Date, until: Date): ApiUsageSummary {
  return db.transaction(() => ({
    days: groupedUsage(db, 'day', since, until),
    surfaces: groupedUsage(db, 'surface', since, until),
  }))();
}
