/**
 * Bounds on one page of a cohort export, and the cursor the next page resumes from.
 *
 * Two bounds rather than one: a row count keeps the query cheap, and a byte ceiling keeps a
 * page that happens to hold large rows from becoming one enormous serialization. A single row
 * bigger than the whole page ceiling is named and streamed on its own rather than dropped,
 * because a cohort member that silently does not appear is a member the comparison later
 * cannot account for.
 *
 * The cursor is the stable key of the last row the page accounted for, never an offset: an
 * offset into a graph that is still taking writes skips and repeats members between pages.
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
  let consumed = 0;

  for (const row of rows) {
    const key = shape.key(row);
    const size = shape.bytes(row);

    if (size > bounds.maxBytes) {
      oversized.push({ key, bytes: size });
      lastKey = key;
      consumed += 1;
      continue;
    }
    if (kept.length >= bounds.maxRows) {
      break;
    }
    if (bytes + size > bounds.maxBytes) {
      break;
    }

    kept.push(row);
    bytes += size;
    lastKey = key;
    consumed += 1;
  }

  const exhausted = consumed === rows.length;
  return {
    rows: kept,
    bytes,
    oversized,
    ...(exhausted || lastKey === undefined ? {} : { nextCursor: lastKey }),
  };
}

/**
 * What a resumed export has to hold to prove it lost nothing: the keys already accounted for
 * and the cursor it stopped at. Kept apart from the page itself so a run that dies between
 * pages resumes from a record rather than from a count.
 */
export type ExportProgress = {
  readonly cursor?: string;
  readonly accounted: readonly string[];
};

export function advanceProgress<T>(
  progress: ExportProgress,
  page: BoundedPage<T>,
  shape: PageShape<T>,
): ExportProgress {
  const accounted = [
    ...progress.accounted,
    ...page.rows.map(shape.key),
    ...page.oversized.map((member) => member.key),
  ];
  return {
    accounted,
    ...(page.nextCursor === undefined ? {} : { cursor: page.nextCursor }),
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
  const missing = expected.filter((key) => !seen.has(key));
  const duplicated = [...seen.entries()]
    .filter(([, count]) => count > 1)
    .map(([key]) => key)
    .sort();
  return { complete: missing.length === 0 && duplicated.length === 0, missing, duplicated };
}
