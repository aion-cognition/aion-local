import Database from 'better-sqlite3';
import type { Driver } from 'neo4j-driver';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { collectBaseline } from './baseline.js';
import { exportCohort } from './export.js';
import { walkNarratives } from './walks.js';
import { checkRehearsalTarget } from '../../domain/campaign-isolation.js';
import { COHORT_PAGE_BOUNDS, type PageShape } from '../../domain/campaign-paging.js';

type Row = { readonly id: string; readonly size: number };
const SHAPE: PageShape<Row> = { key: (row) => row.id, bytes: (row) => row.size };
const emptyDriver = {
  executeQuery: async () => ({ records: [] }),
} as unknown as Driver;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-export-boundary-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

it('refuses a SQLite alias into the production data root', () => {
  const productionRoot = join(dir, 'production');
  const aliasRoot = join(dir, 'alias');
  mkdirSync(productionRoot);
  writeFileSync(join(productionRoot, 'aion.sqlite'), 'review fixture only');
  symlinkSync(productionRoot, aliasRoot);
  const verdict = checkRehearsalTarget({
    production: {
      graphUri: 'bolt://production.invalid:7687',
      sqlitePath: join(productionRoot, 'aion.sqlite'),
    },
    target: { graphUri: 'bolt://owned.invalid:9999', sqlitePath: join(aliasRoot, 'aion.sqlite') },
    declaration: { kind: 'harness', containerName: 'review-owned', createdByThisRun: true },
  });
  expect(verdict).toMatchObject({ status: 'rejected', reason: 'production_data_root' });
});

it('preserves the bytes of earlier pages when resuming after two durable pages', async () => {
  const rows: Row[] = Array.from({ length: 9 }, (_, index) => ({ id: String(index), size: 10 }));
  const request = {
    name: 'members',
    dir,
    shape: SHAPE,
    bounds: { maxRows: 3, maxBytes: 4096 },
    fetch: (cursor: string | undefined, limit: number) =>
      rows.filter((row) => cursor === undefined || row.id > cursor).slice(0, limit),
  };
  await expect(exportCohort({ ...request, failAfterPages: 2 })).rejects.toThrow('interrupted');
  const resumed = await exportCohort(request);
  expect(resumed.complete).toBe(true);
  expect(resumed.members).toHaveLength(9);
  const persisted = readdirSync(join(dir, 'members'))
    .filter((file) => file.startsWith('page-'))
    .flatMap((file) => {
      const page = JSON.parse(readFileSync(join(dir, 'members', file), 'utf8')) as { rows: Row[] };
      return page.rows.map((row) => row.id);
    })
    .sort();
  expect(persisted).toEqual(rows.map((row) => row.id));
});

it('resumes an oversized transfer after its cursor advanced but before its bytes were written', async () => {
  const row: Row = { id: 'huge', size: 3_000_000 };
  mkdirSync(join(dir, 'members'));
  writeFileSync(
    join(dir, 'members', 'page-00000.json'),
    JSON.stringify({
      cursor: null,
      bytes: 0,
      rows: [],
    }),
  );
  // The exact durable state between advanceProgress and streamOversized.
  writeFileSync(
    join(dir, 'members', 'progress.json'),
    JSON.stringify({
      cursor: row.id,
      accounted: [],
      pendingOversized: [{ key: row.id, bytes: row.size }],
    }),
  );
  const result = await exportCohort({
    name: 'members',
    dir,
    shape: SHAPE,
    bounds: { maxRows: 3, maxBytes: 1024 },
    fetch: (cursor) => (cursor === undefined || row.id > cursor ? [row] : []),
  });
  expect(result.complete).toBe(true);
  expect(result.members).toEqual(['huge']);
});

it('includes a transferred oversized row when the baseline reads its export back', async () => {
  const largeSessionId = 's'.repeat(COHORT_PAGE_BOUNDS.maxBytes + 1);
  const driver = {
    executeQuery: async (_statement: string, parameters: Record<string, unknown>) => ({
      records:
        parameters.cursor === null
          ? [
              {
                toObject: () => ({
                  id: 'n1',
                  sessionId: largeSessionId,
                  open: true,
                  validUntil: null,
                }),
              },
            ]
          : [],
    }),
  } as unknown as Driver;
  const result = await walkNarratives(driver, dir);
  expect(result.status).toBe('ok');
  if (result.status !== 'ok') {
    throw new Error(result.detail);
  }
  expect(result.exportComplete).toBe(true);
  expect(result.rows.map((row) => row.id)).toEqual(['n1']);
});

it('preserves an archive census when unrelated optional tables are absent', async () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE experience_archive (
      id TEXT, episode_id TEXT, session_id TEXT, identity TEXT,
      occurred_at TEXT, pipeline_version TEXT, payload_json TEXT
    );
    INSERT INTO experience_archive VALUES
      ('a1', 'e1', 's1', 'i1', '2026-09-01T00:00:00Z', 'v1', '{"observations":["a stored fact"]}');
  `);
  try {
    const result = await collectBaseline({
      driver: emptyDriver,
      db,
      sampledAt: '2026-09-08T00:00:00Z',
      exportDir: dir,
    });
    expect(result.archive?.rows).toBe(1);
    expect(result.gauges.independent_outcomes.api_call_census).toMatchObject({
      status: 'unavailable',
      reason: 'not_installed',
    });
  } finally {
    db.close();
  }
});
