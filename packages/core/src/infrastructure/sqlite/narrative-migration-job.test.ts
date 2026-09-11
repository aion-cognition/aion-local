import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, it } from 'vitest';

import { SqliteStore } from './database.js';
import { recordIngest, countMigrationProgress, readMigrationCohort } from './migration-cohorts.js';
import { sourceReservedForMigration } from './migration-partition.js';
import {
  beginNarrativeMigration,
  readNarrativeMigration,
  advanceNarrativeMigration,
  captureNarrativeMigrationPage,
  freezeNarrativeMigrationCapture,
} from './narrative-migration-job.js';

const NOW = new Date('2026-09-10T10:00:00.000Z');
const policy = {
  maxMembers: 24,
  maxSpanMs: 86400000,
  renderedInputAllowance: 16384,
  partitionPolicyVersion: 1,
};
let store: SqliteStore;
let directory: string;
let path: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'aion-migration-job-'));
  path = join(directory, 'store.sqlite');
  store = new SqliteStore({ filePath: path });
  recordIngest(store.db, 'old', NOW);
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

it('reserves before capture and excludes a later arrival even when its world time is earlier', () => {
  const job = beginNarrativeMigration(store.db, { cohortId: 'cohort', policy, now: NOW });
  recordIngest(store.db, 'late', new Date('2010-01-01T00:00:00Z'));
  expect(sourceReservedForMigration(store.db, 'old')).toBe(true);
  expect(sourceReservedForMigration(store.db, 'late')).toBe(false);
  expect(
    captureNarrativeMigrationPage(
      store.db,
      job,
      ['old', 'late', 'legacy-without-ingest'],
      'page-1',
      NOW,
    ),
  ).toBe(true);
  expect(
    store.db.prepare('SELECT source_id FROM narrative_migration_capture ORDER BY source_id').all(),
  ).toEqual([{ source_id: 'legacy-without-ingest' }, { source_id: 'old' }]);
  expect(captureNarrativeMigrationPage(store.db, job, ['stale-page'], 'page-2', NOW)).toBe(false);
  expect(
    store.db
      .prepare('SELECT source_id FROM narrative_migration_capture WHERE source_id = ?')
      .get('stale-page'),
  ).toBeUndefined();
});

it('keeps examined membership and cursor atomic across a rollback and reopen', () => {
  const job = beginNarrativeMigration(store.db, { cohortId: 'cohort', policy, now: NOW });
  expect(() =>
    store.db
      .transaction(() => {
        captureNarrativeMigrationPage(store.db, job, ['old'], 'after-old', NOW);
        throw new Error('interrupted');
      })
      .immediate(),
  ).toThrow('interrupted');
  store.close();
  store = new SqliteStore({ filePath: path });
  expect(readNarrativeMigration(store.db, 'cohort')).toEqual(job);
  expect(store.db.prepare('SELECT source_id FROM narrative_migration_capture').all()).toEqual([]);
  expect(captureNarrativeMigrationPage(store.db, job, ['old'], 'after-old', NOW)).toBe(true);
  expect(readNarrativeMigration(store.db, 'cohort')?.cursor).toBe('after-old');
});

it('freezes the complete captured denominator without claiming raw verification or discharging work', () => {
  const first = beginNarrativeMigration(store.db, { cohortId: 'cohort', policy, now: NOW });
  captureNarrativeMigrationPage(store.db, first, ['old'], 'archive-end', NOW);
  const captured = readNarrativeMigration(store.db, 'cohort');
  if (captured === undefined) {
    throw new Error('missing job');
  }
  advanceNarrativeMigration(store.db, captured, 'graph', '', NOW);
  const graph = readNarrativeMigration(store.db, 'cohort');
  if (graph === undefined) {
    throw new Error('missing graph phase');
  }
  captureNarrativeMigrationPage(store.db, graph, ['old', 'graph-only'], 'graph-end', NOW);
  const complete = readNarrativeMigration(store.db, 'cohort');
  if (complete === undefined) {
    throw new Error('missing captured phase');
  }
  expect(freezeNarrativeMigrationCapture(store.db, complete, NOW)).toBe(true);
  expect(readMigrationCohort(store.db, 'cohort')?.intakeWatermark).toBe(first.intakeWatermark);
  expect(countMigrationProgress(store.db, 'cohort')).toEqual({
    accounted: 2,
    pinned: 0,
    verified: 0,
  });
  expect(readNarrativeMigration(store.db, 'cohort')?.phase).toBe('verify');
  expect(sourceReservedForMigration(store.db, 'old')).toBe(true);
  expect(freezeNarrativeMigrationCapture(store.db, complete, NOW)).toBe(false);
});

it('rejects a stale second driver and policy changes while retaining the saved job', () => {
  const initial = beginNarrativeMigration(store.db, { cohortId: 'cohort', policy, now: NOW });
  const other = new SqliteStore({ filePath: path });
  try {
    expect(advanceNarrativeMigration(other.db, initial, 'graph', 'first', NOW)).toBe(true);
    expect(advanceNarrativeMigration(store.db, initial, 'complete', 'stale', NOW)).toBe(false);
    const held = readNarrativeMigration(store.db, 'cohort');
    expect(held).toMatchObject({ phase: 'graph', cursor: 'first' });
    expect(() =>
      beginNarrativeMigration(store.db, {
        cohortId: 'cohort',
        policy: { ...policy, maxMembers: 25 },
        now: NOW,
      }),
    ).toThrow('frozen policy');
    expect(readNarrativeMigration(store.db, 'cohort')).toEqual(held);
  } finally {
    other.close();
  }
});

it('refuses an inexact revision instead of comparing rounded cursor versions', () => {
  const job = beginNarrativeMigration(store.db, { cohortId: 'cohort', policy, now: NOW });
  store.db.exec(
    "UPDATE narrative_migration_jobs SET revision = 9007199254740993 WHERE cohort_id = 'cohort'",
  );
  expect(() => readNarrativeMigration(store.db, 'cohort')).toThrow('unsafe cursor');
  expect(() => captureNarrativeMigrationPage(store.db, job, ['stale'], 'new-page', NOW)).toThrow(
    'unsafe cursor',
  );
  expect(store.db.prepare('SELECT source_id FROM narrative_migration_capture').all()).toEqual([]);
});
