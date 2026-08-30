import type { SqliteHandle } from './database.js';
import { getMeta, setMeta } from './meta.js';

/**
 * How often recall is invoked and how often it comes back with nothing: cadence is a
 * measured product signal, not an assumption. Lifetime totals, not a rolling
 * window: `cueDegradedRate`'s window (`recall-samples.ts`) trims to the last 500 calls, but
 * "calls per session" needs a call count that outlives the trim, and `last_pack` keeps only
 * each session's newest pack, never how many times it was served.
 */

const CALLS_META_KEY = 'recall:calls:total';
const EMPTY_META_KEY = 'recall:calls:empty';

function increment(db: SqliteHandle, key: string): void {
  const current = Number(getMeta(db, key) ?? '0');
  setMeta(db, key, String(current + 1));
}

export type RecallOutcome = {
  /** No item in any bucket, first pass or resonant: a real miss, not a rendering artifact. */
  readonly empty: boolean;
};

/** One call, one increment. Called once per recall, at pack persistence. */
export function recordRecallOutcome(db: SqliteHandle, outcome: RecallOutcome): void {
  increment(db, CALLS_META_KEY);
  if (outcome.empty) {
    increment(db, EMPTY_META_KEY);
  }
}

export type RecallCadenceCounters = {
  readonly totalCalls: number;
  readonly emptyPacks: number;
};

export function recallCadenceCounters(db: SqliteHandle): RecallCadenceCounters {
  return {
    totalCalls: Number(getMeta(db, CALLS_META_KEY) ?? '0'),
    emptyPacks: Number(getMeta(db, EMPTY_META_KEY) ?? '0'),
  };
}
