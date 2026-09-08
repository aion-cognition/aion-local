import { describe, expect, it } from 'vitest';

import {
  advanceProgress,
  boundPage,
  exportIsComplete,
  type ExportProgress,
  type PageShape,
} from './campaign-paging.js';

type Row = { readonly id: string; readonly size: number };

const SHAPE: PageShape<Row> = { key: (row) => row.id, bytes: (row) => row.size };

function rows(count: number, size = 10): Row[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `r${String(index).padStart(4, '0')}`,
    size,
  }));
}

describe('bounding one page of a cohort export', () => {
  it('stops at the row ceiling and hands back the key to resume from', () => {
    const page = boundPage(rows(5), SHAPE, { maxRows: 2, maxBytes: 1000 });
    expect(page.rows.map((row) => row.id)).toEqual(['r0000', 'r0001']);
    expect(page.nextCursor).toBe('r0001');
  });

  it('stops at the byte ceiling before the row ceiling', () => {
    const page = boundPage(rows(5, 40), SHAPE, { maxRows: 100, maxBytes: 100 });
    expect(page.rows).toHaveLength(2);
    expect(page.bytes).toBe(80);
    expect(page.nextCursor).toBe('r0001');
  });

  it('names a row larger than the whole page ceiling instead of dropping it', () => {
    const page = boundPage([{ id: 'huge', size: 5000 }, ...rows(2)], SHAPE, {
      maxRows: 10,
      maxBytes: 1000,
    });
    expect(page.oversized).toEqual([{ key: 'huge', bytes: 5000 }]);
    expect(page.rows.map((row) => row.id)).toEqual(['r0000', 'r0001']);
  });

  it('reports no cursor once the rows it was given run out', () => {
    const page = boundPage(rows(2), SHAPE, { maxRows: 10, maxBytes: 1000 });
    expect(page.nextCursor).toBe(undefined);
  });

  it('advances past an oversized row so a resumed read does not see it twice', () => {
    const page = boundPage([{ id: 'huge', size: 5000 }], SHAPE, { maxRows: 10, maxBytes: 10 });
    expect(page.rows).toEqual([]);
    expect(page.nextCursor).toBe(undefined);
    const progress = advanceProgress({ accounted: [] }, page, SHAPE);
    expect(progress.accounted).toEqual(['huge']);
  });
});

describe('resuming an interrupted export', () => {
  it('visits every member exactly once across pages', () => {
    const all = rows(7);
    let progress: ExportProgress = { accounted: [] };
    let cursor: string | undefined;

    for (let pass = 0; pass < 10; pass += 1) {
      const remaining = all.filter((row) => cursor === undefined || row.id > cursor);
      if (remaining.length === 0) {
        break;
      }
      const page = boundPage(remaining, SHAPE, { maxRows: 3, maxBytes: 1000 });
      progress = advanceProgress(progress, page, SHAPE);
      cursor = page.nextCursor;
      if (cursor === undefined) {
        break;
      }
    }

    expect(
      exportIsComplete(
        progress,
        all.map((row) => row.id),
      ),
    ).toEqual({ complete: true, missing: [], duplicated: [] });
  });

  it('names the member a restart lost', () => {
    const progress: ExportProgress = { accounted: ['a', 'c'] };
    expect(exportIsComplete(progress, ['a', 'b', 'c'])).toMatchObject({
      complete: false,
      missing: ['b'],
    });
  });

  it('names the member a restart read twice', () => {
    const progress: ExportProgress = { accounted: ['a', 'a', 'b'] };
    expect(exportIsComplete(progress, ['a', 'b'])).toMatchObject({
      complete: false,
      duplicated: ['a'],
    });
  });
});
