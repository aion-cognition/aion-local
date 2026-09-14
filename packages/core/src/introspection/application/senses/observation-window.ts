import type { SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import {
  countUsageEventsOfKind,
  listUsageEventsOfKind,
  type UsageEventKind,
  type UsageEventRow,
} from '../../../infrastructure/sqlite/usage-events.js';

/**
 * The one shape every sense reports its own reach in.
 *
 * Each sense reads a bounded, current window of its observation kind rather than the whole
 * stream, and the two numbers are different facts: `scanned` is what this reading folded,
 * `inStore` is what the store holds of that kind. A sense that printed only the first would let
 * a reader take "nothing in the window" for "nothing ever", which is the one inference these
 * observations cannot support.
 */
export type ObservationWindow = {
  readonly scanned: number;
  readonly inStore: number;
  /** Rows of this kind older than the window's first row: what this reading did not see. */
  readonly olderThanWindow: number;
};

export type WindowedEvents = {
  readonly rows: readonly UsageEventRow[];
  readonly window: ObservationWindow;
};

/** The most recent `limit` rows of one kind, with the coverage figures that qualify them. */
export function readObservationWindow(
  db: SqliteHandle,
  kind: UsageEventKind,
  limit: number,
): WindowedEvents {
  const rows = listUsageEventsOfKind(db, kind, limit);
  const inStore = countUsageEventsOfKind(db, kind);
  return {
    rows,
    window: {
      scanned: rows.length,
      inStore,
      olderThanWindow: Math.max(0, inStore - rows.length),
    },
  };
}

/** The window with no rows behind it, for a sense that read nothing. */
export const EMPTY_OBSERVATION_WINDOW: ObservationWindow = {
  scanned: 0,
  inStore: 0,
  olderThanWindow: 0,
};

/**
 * The sentence every sense appends to its own evidence, so the model reads one wording for
 * truncation across all five rather than five.
 */
export function describeObservationWindow(label: string, window: ObservationWindow): string {
  if (window.inStore === 0) {
    return `(no ${label} record in the stream yet)`;
  }
  if (window.olderThanWindow === 0) {
    return (
      `(read over all ${String(window.scanned)} ${label} record(s) the stream holds; ` +
      'no record in this window means none was observed, not that none could be)'
    );
  }
  return (
    `(read over the most recent ${String(window.scanned)} of ${String(window.inStore)} ` +
    `${label} record(s); ${String(window.olderThanWindow)} older record(s) sit outside this ` +
    'window, so no record here is no record in the window, not no historical use)'
  );
}
