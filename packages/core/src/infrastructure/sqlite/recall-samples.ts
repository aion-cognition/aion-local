import type { SqliteHandle } from './database.js';
import { getMeta, setMeta } from './meta.js';

/**
 * How often recall answered on a degraded cue stage. It measured 2.2% all-time and 17% under
 * worker load, with the degraded pack indistinguishable from a healthy one in item count and
 * token size, so nothing operational could tell a bad hour from a good one. The
 * signal is a rate rather than a count: 33 degraded recalls means nothing without the 1,469
 * they came from.
 *
 * A rolling window of outcomes, same shape and same reason as `lag-samples.ts`: a lifetime
 * average would hide the tail an operator is looking for, and an operator asking this question
 * is asking about the last hour. One character per recall rather than a running pair of
 * counters, so a quiet hour after a bad one reads as quiet instead of decaying toward it.
 */

/** Recalls the rate is computed over. Wide enough to be stable, short enough to move in an hour. */
export const DEFAULT_RECALL_SAMPLE_WINDOW = 500;

const CUE_DEGRADED_META_KEY = 'recall:cues:degraded_window';

/** One character per recall, newest last: `1` degraded, `0` not. */
function readWindow(db: SqliteHandle): string {
  return getMeta(db, CUE_DEGRADED_META_KEY) ?? '';
}

/** FIFO over `windowSize`: the oldest outcome is dropped first once the window is full. */
export function recordCueOutcome(
  db: SqliteHandle,
  degraded: boolean,
  windowSize: number = DEFAULT_RECALL_SAMPLE_WINDOW,
): void {
  const held = `${readWindow(db)}${degraded ? '1' : '0'}`;
  const trimmed = held.length > windowSize ? held.slice(held.length - windowSize) : held;
  setMeta(db, CUE_DEGRADED_META_KEY, trimmed);
}

/** `undefined` until the first recall lands, rather than a zero that reads as "measured, fine". */
export function cueDegradedRate(db: SqliteHandle): number | undefined {
  const window = readWindow(db);
  if (window.length === 0) {
    return undefined;
  }
  let degraded = 0;
  for (const outcome of window) {
    if (outcome === '1') {
      degraded += 1;
    }
  }
  return degraded / window.length;
}
