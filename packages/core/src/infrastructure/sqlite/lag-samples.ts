import type { SqliteHandle } from './database.js';
import { getMeta, setMeta } from './meta.js';

/**
 * Enrichment lag: wall time from a job's `enqueued_at` to the moment the orchestrator marks
 * its ledger key applied. A rolling window of raw samples, not a running average — EX-10
 * measured the p95 of this figure at 95% queueing, and a mean would hide exactly the tail a
 * freshness signal exists to catch. `reflection-queue.ts` deletes a job's row on completion
 * (`claim.ts`), so nothing durable survives the run itself; this is the only record of it.
 */

/** Newest `windowSize` samples only, so the figure tracks current conditions, not history. */
export const DEFAULT_LAG_SAMPLE_WINDOW = 500;

const LAG_SAMPLES_META_KEY = 'reflection:lag:samples';

function readSamples(db: SqliteHandle): number[] {
  const raw = getMeta(db, LAG_SAMPLES_META_KEY);
  if (raw === undefined) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is number => typeof value === 'number') : [];
  } catch {
    return [];
  }
}

/** FIFO over `windowSize`: the oldest sample is dropped first once the window is full. */
export function recordEnrichmentLagMs(
  db: SqliteHandle,
  ms: number,
  windowSize: number = DEFAULT_LAG_SAMPLE_WINDOW,
): void {
  const samples = readSamples(db);
  samples.push(Math.max(0, Math.round(ms)));
  const trimmed = samples.length > windowSize ? samples.slice(samples.length - windowSize) : samples;
  setMeta(db, LAG_SAMPLES_META_KEY, JSON.stringify(trimmed));
}

export function listEnrichmentLagSamplesMs(db: SqliteHandle): readonly number[] {
  return readSamples(db);
}

/**
 * Linear-interpolated p95 over the current window, `undefined` until the first sample lands
 * rather than a misleading zero. Not imported from the recall floor calibration's own
 * `percentile`: that lives in the recall domain and this is an unrelated bounded context, so
 * a four-line duplicate beats a cross-layer dependency for a formula this small.
 */
export function p95EnrichmentLagMs(db: SqliteHandle): number | undefined {
  const samples = readSamples(db);
  if (samples.length === 0) {
    return undefined;
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const position = (sorted.length - 1) * 0.95;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const low = sorted[lower] ?? Number.NaN;
  const high = sorted[upper] ?? Number.NaN;
  return Math.round(low + (high - low) * (position - lower));
}
