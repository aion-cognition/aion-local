/**
 * Bounds on one page of a cohort export, and the cursor the next page resumes from.
 *
 * Two bounds rather than one: a row count keeps the query cheap, and a byte ceiling keeps a
 * page that happens to hold large rows from becoming one enormous serialization. A single row
 * bigger than the whole page ceiling is named and streamed on its own rather than dropped,
 * because a cohort member that silently does not appear is a member the comparison later
 * cannot account for. Naming it is not exporting it: an oversized member is accounted for only
 * once its own bytes and their checksum are persisted.
 *
 * The cursor is the stable key of the last row the page examined, never an offset: an offset
 * into a graph that is still taking writes skips and repeats members between pages. A page that
 * consumed everything it was handed still reports a cursor, because the rows it was handed are
 * one fetch and not the store.
 */

export type PageBounds = {
  readonly maxRows: number;
  readonly maxBytes: number;
};

export const COHORT_PAGE_BOUNDS: PageBounds = {
  maxRows: 200,
  maxBytes: 2 * 1024 * 1024,
};

/** A member too large for a page ceiling. It is exported by name with its own byte count. */
export type OversizedMember = {
  readonly key: string;
  readonly bytes: number;
};

export type BoundedPage<T> = {
  readonly rows: readonly T[];
  readonly bytes: number;
  /** Pass back as the next read's cursor. Absent when the page consumed every row it was given. */
  readonly nextCursor?: string;
  readonly oversized: readonly OversizedMember[];
};

export type PageShape<T> = {
  readonly key: (row: T) => string;
  readonly bytes: (row: T) => number;
};

/**
 * Applies the bounds to rows already read in stable-key order.
 *
 * An oversized row advances the cursor past itself: it is accounted for, in `oversized`, so a
 * resumed read must not hand it back. A page always accounts for at least one row, which is
 * what stops a resumed export from looping on the same member forever.
 */
export function boundPage<T>(
  rows: readonly T[],
  shape: PageShape<T>,
  bounds: PageBounds = COHORT_PAGE_BOUNDS,
): BoundedPage<T> {
  const kept: T[] = [];
  const oversized: OversizedMember[] = [];
  let bytes = 0;
  let lastKey: string | undefined;

  for (const row of rows) {
    const key = shape.key(row);
    const size = shape.bytes(row);

    // Every member the page looks at counts against the row cap, oversized ones included: a
    // page that examined a thousand members did that work whatever it managed to carry.
    if (kept.length + oversized.length >= bounds.maxRows) {
      break;
    }
    if (size > bounds.maxBytes) {
      oversized.push({ key, bytes: size });
      lastKey = key;
      continue;
    }
    if (bytes + size > bounds.maxBytes) {
      break;
    }

    kept.push(row);
    bytes += size;
    lastKey = key;
  }

  return {
    rows: kept,
    bytes,
    oversized,
    ...(lastKey === undefined ? {} : { nextCursor: lastKey }),
  };
}

/**
 * What a resumed export has to hold to prove it lost nothing: the keys already accounted for
 * and the cursor it stopped at. Kept apart from the page itself so a run that dies between
 * pages resumes from a record rather than from a count.
 */
export type ExportProgress = {
  readonly cursor?: string;
  /** Members whose content is persisted. */
  readonly accounted: readonly string[];
  /**
   * Members named by a page and still owed their own stream. Never counted as exported.
   * Absent on a record written before any page named one, which reads as none owed.
   */
  readonly pendingOversized?: readonly OversizedMember[];
};

export const EMPTY_PROGRESS: ExportProgress = { accounted: [], pendingOversized: [] };

/**
 * Folds one written page into the record. Rows the page carried are accounted for, since the
 * page holding them is what was persisted. An oversized member only becomes owed work here:
 * naming it in a page exports nothing, so it waits for its own transfer.
 */
export function advanceProgress<T>(
  progress: ExportProgress,
  page: BoundedPage<T>,
  shape: PageShape<T>,
): ExportProgress {
  const pending = progress.pendingOversized ?? [];
  const named = new Set(pending.map((member) => member.key));
  return {
    accounted: [...progress.accounted, ...page.rows.map(shape.key)],
    pendingOversized: [...pending, ...page.oversized.filter((member) => !named.has(member.key))],
    ...(page.nextCursor === undefined ? {} : { cursor: page.nextCursor }),
  };
}

/** Moves one oversized member across, once its bytes and their checksum are on disk. */
export function recordOversizedExport(progress: ExportProgress, key: string): ExportProgress {
  const pending = progress.pendingOversized ?? [];
  if (!pending.some((member) => member.key === key)) {
    return progress;
  }
  return {
    ...progress,
    accounted: [...progress.accounted, key],
    pendingOversized: pending.filter((member) => member.key !== key),
  };
}

/**
 * Whether the walk visited every frozen member exactly once. A digest over the accounted keys
 * would tell a caller that two runs agree; only the list says which member is missing.
 */
export function exportIsComplete(
  progress: ExportProgress,
  expected: readonly string[],
): {
  readonly complete: boolean;
  readonly missing: readonly string[];
  readonly duplicated: readonly string[];
} {
  const seen = new Map<string, number>();
  for (const key of progress.accounted) {
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const pending = new Set((progress.pendingOversized ?? []).map((member) => member.key));
  const missing = expected.filter((key) => !seen.has(key) || pending.has(key));
  const duplicated = [...seen.entries()]
    .filter(([, count]) => count > 1)
    .map(([key]) => key)
    .sort();
  return { complete: missing.length === 0 && duplicated.length === 0, missing, duplicated };
}
