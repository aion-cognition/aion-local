import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { exportCohort, readProgress } from './export.js';
import type { PageShape } from '../../domain/campaign-paging.js';

type Row = { readonly id: string; readonly size: number };

const SHAPE: PageShape<Row> = { key: (row) => row.id, bytes: (row) => row.size };

function corpus(count: number, size = 10): Row[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `r${String(index).padStart(4, '0')}`,
    size,
  }));
}

/** A keyset read: ordered by the stable key, everything after the cursor. */
function fetcher(rows: readonly Row[]) {
  const ordered = [...rows].sort((left, right) => left.id.localeCompare(right.id));
  return (cursor: string | undefined, limit: number): readonly Row[] =>
    ordered.filter((row) => cursor === undefined || row.id > cursor).slice(0, limit);
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-cohort-export-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function pageFiles(name: string): string[] {
  return readdirSync(join(dir, name))
    .filter((file) => file.startsWith('page-'))
    .sort();
}

describe('exporting a cohort to disk', () => {
  it('writes a page per fetch and accounts for every member once', async () => {
    const result = await exportCohort({
      name: 'members',
      dir,
      fetch: fetcher(corpus(7)),
      shape: SHAPE,
      bounds: { maxRows: 3, maxBytes: 4096 },
    });

    expect(result.complete).toBe(true);
    expect(result.members).toHaveLength(7);
    expect(new Set(result.members).size).toBe(7);
    expect(pageFiles('members')).toHaveLength(3);
  });

  it('resumes from the record a killed run left behind, losing and repeating nothing', async () => {
    const rows = corpus(9);
    await expect(
      exportCohort({
        name: 'members',
        dir,
        fetch: fetcher(rows),
        shape: SHAPE,
        bounds: { maxRows: 3, maxBytes: 4096 },
        failAfterPages: 2,
      }),
    ).rejects.toThrow('interrupted');

    const partial = JSON.parse(readFileSync(join(dir, 'members', 'progress.json'), 'utf8')) as {
      accounted: string[];
      cursor?: string;
    };
    expect(partial.accounted).toHaveLength(6);
    expect(partial.cursor).toBe('r0005');

    const resumed = await exportCohort({
      name: 'members',
      dir,
      fetch: fetcher(rows),
      shape: SHAPE,
      bounds: { maxRows: 3, maxBytes: 4096 },
    });
    expect(resumed.complete).toBe(true);
    expect(resumed.members).toHaveLength(9);
    expect(new Set(resumed.members).size).toBe(9);
  });

  it('marks an oversized member exported only once its bytes and digest are on disk', async () => {
    const rows: Row[] = [
      { id: 'r0000', size: 10 },
      { id: 'r0001-huge', size: 3_000_000 },
      { id: 'r0002', size: 10 },
    ];
    const result = await exportCohort({
      name: 'members',
      dir,
      fetch: fetcher(rows),
      shape: SHAPE,
      bounds: { maxRows: 10, maxBytes: 1024 },
    });

    expect(result.complete).toBe(true);
    expect(result.members).toContain('r0001-huge');
    expect(result.oversized).toEqual([]);

    const streamed = readdirSync(join(dir, 'members', 'oversized')).sort();
    expect(streamed).toEqual(['r0001-huge.json', 'r0001-huge.sha256.json']);
    const digest = JSON.parse(
      readFileSync(join(dir, 'members', 'oversized', 'r0001-huge.sha256.json'), 'utf8'),
    ) as { sha256: string; key: string };
    expect(digest.key).toBe('r0001-huge');
    expect(digest.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('still owes an oversized member whose transfer never ran', async () => {
    const rows: Row[] = [{ id: 'r0000-huge', size: 3_000_000 }];
    // The fetch answers once and the run dies before the page is written, so nothing is owed
    // and nothing is claimed.
    await expect(
      exportCohort({
        name: 'members',
        dir,
        fetch: fetcher(rows),
        shape: SHAPE,
        bounds: { maxRows: 10, maxBytes: 1024 },
        failAfterPages: 0,
      }),
    ).rejects.toThrow('interrupted');
    expect(pageFiles('members')).toEqual([]);
  });
});

describe('recovering an interrupted export', () => {
  it('refuses to continue over a progress record it cannot read', async () => {
    mkdirSync(join(dir, 'members', 'oversized'), { recursive: true });
    writeFileSync(join(dir, 'members', 'progress.json'), 'not json');
    await expect(
      exportCohort({ name: 'members', dir, fetch: fetcher(corpus(2)), shape: SHAPE }),
    ).rejects.toThrow('cannot read');
  });

  it('tells an absent record from an unreadable one', () => {
    expect(readProgress(dir, 'members')).toEqual({ status: 'absent' });
    mkdirSync(join(dir, 'members'), { recursive: true });
    writeFileSync(join(dir, 'members', 'progress.json'), 'not json');
    expect(readProgress(dir, 'members').status).toBe('unreadable');
  });

  it('reports a member the record claims that no page holds', async () => {
    const rows = corpus(3);
    await exportCohort({
      name: 'members',
      dir,
      fetch: fetcher(rows),
      shape: SHAPE,
      bounds: { maxRows: 3, maxBytes: 4096 },
    });
    rmSync(join(dir, 'members', 'page-00000.json'));

    const again = await exportCohort({
      name: 'members',
      dir,
      fetch: fetcher(rows),
      shape: SHAPE,
      bounds: { maxRows: 3, maxBytes: 4096 },
    });
    expect(again.complete).toBe(false);
    expect(again.missing).toEqual(['r0000', 'r0001', 'r0002']);
  });

  it('leaves no half-written progress record behind', async () => {
    await exportCohort({ name: 'members', dir, fetch: fetcher(corpus(2)), shape: SHAPE });
    expect(readdirSync(join(dir, 'members')).some((file) => file.endsWith('.writing'))).toBe(false);
  });
});
