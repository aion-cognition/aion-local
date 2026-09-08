import type * as FsModule from 'node:fs';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { exportCohort, verifyTransfer } from './export.js';
import { checkRehearsalTarget, dataRootVerdict } from '../../domain/campaign-isolation.js';
import type { PageShape } from '../../domain/campaign-paging.js';

const fault = vi.hoisted(() => ({ failProgressRename: false }));
vi.mock('node:fs', async (original) => {
  const module = await original<typeof FsModule>();
  return {
    ...module,
    renameSync: (from: FsModule.PathLike, to: FsModule.PathLike): void => {
      if (fault.failProgressRename && String(to).endsWith('/progress.json')) {
        fault.failProgressRename = false;
        throw new Error('interrupted progress publication');
      }
      module.renameSync(from, to);
    },
  };
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-combined-boundary-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

it('refuses a dangling file symlink that would create a file inside the production directory', () => {
  const production = join(dir, 'production');
  const clone = join(dir, 'clone');
  mkdirSync(production);
  mkdirSync(clone);
  writeFileSync(join(production, 'aion.sqlite'), 'production fixture');
  const destination = join(production, 'not-created.sqlite');
  const target = join(clone, 'link.sqlite');
  symlinkSync(destination, target);
  const verdict = checkRehearsalTarget({
    production: {
      graphUri: 'bolt://production.invalid:7687',
      sqlitePath: join(production, 'aion.sqlite'),
    },
    target: { graphUri: 'bolt://owned.invalid:9999', sqlitePath: target },
    declaration: { kind: 'harness', containerName: 'review-owned', createdByThisRun: true },
  });
  // Prove the write destination, using only temporary fixture directories.
  writeFileSync(target, 'created through alias');
  expect(readFileSync(destination, 'utf8')).toBe('created through alias');
  expect(verdict.status).toBe('rejected');
});

it('treats the filesystem root as containing a descendant data directory', () => {
  const rootFile = join('/', 'aion-root-review.sqlite');
  expect(dataRootVerdict(join(dir, 'clone.sqlite'), rootFile)).toBe('overlapping');
});

it('verifies the stored bytes before decoding a transferred UTF-8 payload', async () => {
  const row = { id: 'large', size: 3000, note: String.fromCharCode(0xfffd) };
  await exportCohort<typeof row>({
    name: 'members',
    dir,
    shape: { key: (item) => item.id, bytes: (item) => item.size },
    bounds: { maxRows: 1, maxBytes: 1024 },
    fetch: (cursor) => (cursor === undefined ? [row] : []),
  });
  const path = join(dir, 'members', 'oversized', 'large.json');
  const original = readFileSync(path);
  const index = original.indexOf(Buffer.from([0xef, 0xbf, 0xbd]));
  expect(index).toBeGreaterThanOrEqual(0);
  const corrupted = Buffer.concat([
    original.subarray(0, index),
    Buffer.from([0xff]),
    original.subarray(index + 3),
  ]);
  expect(corrupted.length).not.toBe(original.length);
  expect(corrupted.toString('utf8')).toBe(original.toString('utf8'));
  writeFileSync(path, corrupted);
  expect(verifyTransfer(dir, 'members', 'large')).toBeUndefined();
});

it('recovers the oversized member before a kept member after page persistence but before progress', async () => {
  type Row = { readonly id: string; readonly size: number };
  const rows: Row[] = [
    { id: 'a-large', size: 3000 },
    { id: 'b-kept', size: 10 },
  ];
  const shape: PageShape<Row> = { key: (row) => row.id, bytes: (row) => row.size };
  const bounds = { maxRows: 2, maxBytes: 1024 };
  const request = {
    name: 'members',
    dir,
    shape,
    bounds,
    fetch: (cursor: string | undefined, limit: number) =>
      rows.filter((row) => cursor === undefined || row.id > cursor).slice(0, limit),
    fetchKey: (key: string) => rows.filter((row) => row.id === key),
  };
  // Exercise the actual page writer, then interrupt its progress publication.
  fault.failProgressRename = true;
  await expect(exportCohort(request)).rejects.toThrow('interrupted progress publication');
  const result = await exportCohort(request);
  expect(result.complete).toBe(true);
  expect([...result.members].sort()).toEqual(rows.map((row) => row.id));
});
