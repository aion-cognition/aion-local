import type * as FsModule from 'node:fs';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { exportCohort, type CohortExportRequest } from './export.js';
import { canonicalPath, dataRootVerdict } from '../../domain/campaign-isolation.js';

const fault = vi.hoisted(() => ({ renameCount: 0, afterRename: 0, fired: false }));
vi.mock('node:fs', async (original) => {
  const module = await original<typeof FsModule>();
  return {
    ...module,
    renameSync: (from: FsModule.PathLike, to: FsModule.PathLike): void => {
      module.renameSync(from, to);
      fault.renameCount += 1;
      if (fault.afterRename !== 0 && fault.renameCount === fault.afterRename) {
        fault.fired = true;
        fault.afterRename = 0;
        throw new Error('interrupted after durable rename');
      }
    },
  };
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-export-matrix-'));
  fault.renameCount = 0;
  fault.afterRename = 0;
  fault.fired = false;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

type Row = { readonly id: string; readonly payload: string };
const cases = [
  ...Array.from({ length: 3 }, (_, index) => ({ kind: 'normal', after: index + 1 })),
  ...Array.from({ length: 6 }, (_, index) => ({ kind: 'mixed', after: index + 1 })),
  ...Array.from({ length: 9 }, (_, index) => ({ kind: 'oversized', after: index + 1 })),
];
it.each(cases)('recovers $kind rows after durable rename $after', async ({ kind, after }) => {
  const rows: Row[] = [
    { id: 'a', payload: kind === 'normal' ? 'first' : 'a'.repeat(1800) },
    { id: 'b', payload: kind === 'oversized' ? 'b'.repeat(1800) : 'second' },
  ];
  const request: CohortExportRequest<Row> = {
    name: 'members',
    dir,
    bounds: { maxRows: 2, maxBytes: 1024 },
    shape: { key: (row) => row.id, bytes: (row) => Buffer.byteLength(JSON.stringify(row)) },
    fetch: (cursor, limit) =>
      rows.filter((row) => cursor === undefined || row.id > cursor).slice(0, limit),
    fetchKey: (key) => rows.filter((row) => row.id === key),
  };
  fault.afterRename = after;
  await expect(exportCohort(request)).rejects.toThrow('interrupted after durable rename');
  expect(fault.fired).toBe(true);
  const result = await exportCohort(request);
  expect(result.complete).toBe(true);
  expect([...result.members].sort()).toEqual(['a', 'b']);
  expect(result.oversized).toEqual([]);
  expect(result.duplicated).toEqual([]);
  expect(result.missing).toEqual([]);
  expect((await exportCohort(request)).members).toEqual(result.members);
});

it('follows a relative dangling link into the production directory', () => {
  mkdirSync(join(dir, 'production'));
  mkdirSync(join(dir, 'clone'));
  writeFileSync(join(dir, 'production', 'aion.sqlite'), 'fixture');
  symlinkSync('../production/new.sqlite', join(dir, 'clone', 'link'));
  expect(dataRootVerdict(join(dir, 'clone', 'link'), join(dir, 'production', 'aion.sqlite'))).toBe(
    'overlapping',
  );
});

it('follows a dangling directory link before appending a missing leaf', () => {
  mkdirSync(join(dir, 'production'));
  mkdirSync(join(dir, 'clone'));
  writeFileSync(join(dir, 'production', 'aion.sqlite'), 'fixture');
  symlinkSync('../production/new-directory', join(dir, 'clone', 'link'));
  expect(
    dataRootVerdict(
      join(dir, 'clone', 'link', 'new.sqlite'),
      join(dir, 'production', 'aion.sqlite'),
    ),
  ).toBe('overlapping');
});

it('refuses a denied resolver before guessing an identity', () => {
  expect(
    canonicalPath(join(dir, 'missing'), () => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    }),
  ).toBeUndefined();
});
