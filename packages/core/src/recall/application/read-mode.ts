import type { RecallInput } from '@aion/protocol';

import {
  asOf,
  bitemporalAt,
  knewAt,
  withCurrency,
  type ReadMode,
} from '../../infrastructure/graph/read-modes.js';

export type ReadModeContext = {
  /** The run's own clock, read once at the top of the call. */
  readonly now: Date;
  /** The expiry kill switch, carried so it reaches the currency comparator. */
  readonly expiryAnnotation: boolean;
};

/**
 * A recall request, of which only the two temporal fields decide the mode. Stated as a partial
 * so a caller holding the pair alone, such as the coverage checker, passes the pair alone.
 */
export type ReadModeInput = Partial<RecallInput>;

/**
 * The one read mode a whole recall judges currency from. A recall issues a dozen fragments
 * across seeds, traversal, hydration and the second pass, and a mode with no clock on it leaves
 * each of them reading the wall clock for itself: a reading sitting on its horizon comes back
 * current on one leg and expired on the next, and fusion picks the survivor by relevance rather
 * than by currency. A pinned world or knowledge time already supplies its own vantage point, so
 * only the default read takes the run's clock.
 *
 * The mode it builds is an interval, not a promise about coverage. An application entry point
 * obtains its checked context from the coverage checker, which wraps this call rather than
 * replacing it.
 */
export function readModeFor(input: ReadModeInput, context: ReadModeContext): ReadMode {
  const expiry = context.expiryAnnotation ? {} : { expiryAnnotation: false };
  const validAt = input.as_of === undefined ? undefined : new Date(input.as_of);
  const knownAt = input.knew_at === undefined ? undefined : new Date(input.knew_at);
  if (validAt !== undefined && knownAt !== undefined) {
    return { ...bitemporalAt(validAt, knownAt), ...expiry };
  }
  if (validAt !== undefined) {
    return { ...asOf(validAt), ...expiry };
  }
  if (knownAt !== undefined) {
    return { ...knewAt(knownAt), ...expiry };
  }
  return { ...withCurrency(context.now), ...expiry };
}
