import { summarizeApiCalls } from '../../../infrastructure/sqlite/api-usage.js';
import type { SqliteHandle } from '../../../infrastructure/sqlite/database.js';

/**
 * The batch-cadence ruling packet's data section: how long a submitted batch item waits for its
 * answer, and how much of the traffic in the window read from cache.
 *
 * Both readings carry the same caveat. `submitted_at`/`settled_at` on `batch_work` are this
 * process's own wall-clock stamps at the moment it noticed a state change, not the remote's
 * server-side submission or completion time: a poll interval and a restart both stretch the
 * gap between a real event and this process observing it. An empty population from either read
 * is a valid result (no batch work settled, or no metered calls, in the window), not evidence
 * that cadence is fast or that caching is perfect.
 */

export type BatchCadenceSample = {
  readonly workKey: string;
  /** Milliseconds between this process observing submission and observing settlement. */
  readonly observedLatencyMs: number;
};

export type BatchCadenceReport = {
  readonly since: string;
  readonly until: string;
  readonly settledSamples: readonly BatchCadenceSample[];
  readonly medianObservedLatencyMs: number | undefined;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  /**
   * Uncached input only. The API bills the three input classes apart and never overlaps them, so
   * this is a part of the window's input rather than its total; the share served from cache is
   * taken over all three in `describeBatchCadenceReport`.
   */
  readonly inputTokens: number;
  readonly metredCalls: number;
};

type BatchLatencyRow = {
  work_key: string;
  submitted_at: string | null;
  settled_at: string | null;
};

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Every applied batch item in the window with both stamps this process recorded, for the
 * observed-latency sample. `state = 'applied'` only: a pending or failed item has no settlement
 * to measure, and a discarded one was never going to be.
 */
function settledLatencies(
  db: SqliteHandle,
  since: Date,
  until: Date,
): readonly BatchCadenceSample[] {
  const rows = db
    .prepare(
      `SELECT work_key, submitted_at, settled_at FROM batch_work
       WHERE state = 'applied' AND submitted_at IS NOT NULL AND settled_at IS NOT NULL
         AND settled_at >= ? AND settled_at < ?
       ORDER BY settled_at ASC`,
    )
    .all(since.toISOString(), until.toISOString()) as BatchLatencyRow[];
  return rows
    .filter(
      (row): row is BatchLatencyRow & { submitted_at: string; settled_at: string } =>
        row.submitted_at !== null && row.settled_at !== null,
    )
    .map((row) => ({
      workKey: row.work_key,
      observedLatencyMs: new Date(row.settled_at).getTime() - new Date(row.submitted_at).getTime(),
    }));
}

export function buildBatchCadenceReport(
  db: SqliteHandle,
  since: Date,
  until: Date,
): BatchCadenceReport {
  const settledSamples = settledLatencies(db, since, until);
  const usage = summarizeApiCalls(db, since, until);
  const cacheReadTokens = usage.days.reduce((sum, day) => sum + day.cacheReadTokens, 0);
  const cacheCreationTokens = usage.days.reduce((sum, day) => sum + day.cacheCreationTokens, 0);
  const inputTokens = usage.days.reduce((sum, day) => sum + day.inputTokens, 0);
  const metredCalls = usage.days.reduce((sum, day) => sum + day.calls, 0);
  return {
    since: since.toISOString(),
    until: until.toISOString(),
    settledSamples,
    medianObservedLatencyMs: median(settledSamples.map((sample) => sample.observedLatencyMs)),
    cacheReadTokens,
    cacheCreationTokens,
    inputTokens,
    metredCalls,
  };
}

/** The packet's data section, rendered as the lines a reader pastes into the ruling document. */
export function describeBatchCadenceReport(report: BatchCadenceReport): readonly string[] {
  const latencyLine =
    report.settledSamples.length === 0
      ? 'no batch item settled in this window'
      : `${String(report.settledSamples.length)} settled item(s), median observed latency ` +
        `${((report.medianObservedLatencyMs ?? 0) / 1000).toFixed(1)}s (this process's own ` +
        "submit/settle stamps, not the remote's server times)";
  // The three input classes the API bills apart and never overlaps: uncached input, tokens read
  // from cache, and tokens written to it. The share served from cache is a share of all three,
  // not of the uncached remainder: 90 cached against 10 uncached is 90%, and dividing by the
  // uncached part alone reported it as 900%. A window with no input tokens of any class has no
  // share to state, which is not the same as a 0% one.
  const totalInputTokens = report.inputTokens + report.cacheReadTokens + report.cacheCreationTokens;
  const cacheShare =
    totalInputTokens === 0
      ? 'no input token in any class, so no cache share'
      : `${((report.cacheReadTokens / totalInputTokens) * 100).toFixed(1)}% served from cache`;
  const cacheLine =
    report.metredCalls === 0
      ? 'no metered API call in this window'
      : `${String(report.metredCalls)} metered call(s), ${String(report.cacheReadTokens)} cache ` +
        `read token(s) against ${String(totalInputTokens)} input token(s) across all classes ` +
        `(${cacheShare}), ${String(report.inputTokens)} uncached, ` +
        `${String(report.cacheCreationTokens)} cache-write token(s)`;
  return [
    `batch cadence, ${report.since} to ${report.until}:`,
    latencyLine,
    cacheLine,
    'An empty population above is a valid result, not evidence of zero latency or perfect caching.',
  ];
}
