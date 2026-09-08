import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { exportCohort } from './export.js';
import {
  canonicalPath,
  checkRehearsalTarget,
  dataRootVerdict,
} from '../../domain/campaign-isolation.js';
import type { PageShape } from '../../domain/campaign-paging.js';

type Row = { readonly id: string; readonly size: number; readonly note?: string };
const shape: PageShape<Row> = { key: (row) => row.id, bytes: (row) => row.size };
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-recovery-review-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

it('refuses a symlink followed by parent traversal that opens the production file', () => {
  const production = join(dir, 'production');
  const clone = join(dir, 'clone');
  mkdirSync(join(production, 'nested'), { recursive: true });
  mkdirSync(clone);
  writeFileSync(join(production, 'aion.sqlite'), 'production fixture');
  writeFileSync(join(clone, 'aion.sqlite'), 'clone fixture');
  symlinkSync(join(production, 'nested'), join(clone, 'link'));
  const target = `${clone}/link/../aion.sqlite`;
  expect(readFileSync(target, 'utf8')).toBe('production fixture');
  expect(realpathSync.native(target)).toBe(realpathSync.native(join(production, 'aion.sqlite')));
  expect(
    checkRehearsalTarget({
      production: {
        graphUri: 'bolt://production.invalid:7687',
        sqlitePath: join(production, 'aion.sqlite'),
      },
      target: { graphUri: 'bolt://owned.invalid:9999', sqlitePath: target },
      declaration: { kind: 'harness', containerName: 'review-owned', createdByThisRun: true },
    }),
  ).toMatchObject({ status: 'rejected', reason: 'production_data_root' });
});

it('keeps a symlink loop unresolvable instead of inventing an identity from its parent', () => {
  symlinkSync('cycle', join(dir, 'cycle'));
  const target = `${dir}/cycle/aion.sqlite`;
  expect(canonicalPath(target)).toBeUndefined();
  expect(dataRootVerdict(target, join(dir, 'production', 'aion.sqlite'))).toBe('unresolvable');
});

it('recovers a page committed before progress without publishing duplicate members', async () => {
  const row: Row = { id: 'a', size: 10 };
  mkdirSync(join(dir, 'members'));
  writeFileSync(
    join(dir, 'members', 'progress.json'),
    JSON.stringify({
      accounted: [],
      pendingOversized: [],
    }),
  );
  writeFileSync(
    join(dir, 'members', 'page-00000.json'),
    JSON.stringify({
      cursor: null,
      next: 'a',
      bytes: 10,
      keys: ['a'],
      oversized: [],
      rows: [row],
    }),
  );
  const result = await exportCohort({
    name: 'members',
    dir,
    shape,
    bounds: { maxRows: 1, maxBytes: 1024 },
    fetch: (cursor) => (cursor === undefined || row.id > cursor ? [row] : []),
  });
  expect(result.complete).toBe(true);
  expect(result.members).toEqual(['a']);
});

it('recovers a pending key even when a page of keys sorts after its guessed predecessor', async () => {
  const prefix: Row[] = [
    { id: 'hugda', size: 10 },
    { id: 'hugdb', size: 10 },
  ];
  const huge: Row = { id: 'huge', size: 3000 };
  const rows = [...prefix, huge];
  mkdirSync(join(dir, 'members'));
  writeFileSync(
    join(dir, 'members', 'page-00000.json'),
    JSON.stringify({
      cursor: null,
      bytes: 20,
      keys: prefix.map((row) => row.id),
      rows: prefix,
    }),
  );
  writeFileSync(
    join(dir, 'members', 'page-00001.json'),
    JSON.stringify({
      cursor: 'hugdb',
      bytes: 0,
      keys: [],
      rows: [],
    }),
  );
  writeFileSync(
    join(dir, 'members', 'progress.json'),
    JSON.stringify({
      cursor: 'huge',
      accounted: prefix.map((row) => row.id),
      pendingOversized: [{ key: 'huge', bytes: 3000 }],
    }),
  );
  const result = await exportCohort({
    name: 'members',
    dir,
    shape,
    bounds: { maxRows: 2, maxBytes: 1024 },
    fetch: (cursor, limit) =>
      rows.filter((row) => cursor === undefined || row.id > cursor).slice(0, limit),
  });
  expect(result.complete).toBe(true);
  expect(result.members).toContain('huge');
});

it.each(['missing', 'changed'] as const)(
  'does not certify an oversized transfer with %s payload bytes',
  async (kind) => {
    const row: Row = { id: 'huge', size: 3000, note: 'first' };
    const request = {
      name: 'members',
      dir,
      shape,
      bounds: { maxRows: 2, maxBytes: 1024 },
      fetch: (cursor: string | undefined) => (cursor === undefined || row.id > cursor ? [row] : []),
    };
    expect((await exportCohort(request)).complete).toBe(true);
    const payload = join(dir, 'members', 'oversized', 'huge.json');
    if (kind === 'missing') {
      rmSync(payload);
    } else {
      writeFileSync(payload, `${JSON.stringify({ ...row, note: 'other' }, null, 2)}\n`);
    }
    let complete = false;
    try {
      ({ complete } = await exportCohort(request));
    } catch {
      // Explicit refusal is also valid; a digest file alone is not a verified transfer.
    }
    expect(complete).toBe(false);
  },
);
