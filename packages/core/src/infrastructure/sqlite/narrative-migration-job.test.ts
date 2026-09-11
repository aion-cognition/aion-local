import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, it } from 'vitest';

import { SqliteStore } from './database.js';
import {
  recordIngest,
  countMigrationProgress,
  readMigrationCohort,
  freezeMigrationCohort,
} from './migration-cohorts.js';
import { sourceReservedForMigration } from './migration-partition.js';
import {
  beginNarrativeMigration,
  MIGRATION_COHORT_LIMIT,
  readNarrativeMigration,
  advanceNarrativeMigration,
  captureNarrativeMigrationPage,
  freezeNarrativeMigrationCapture,
} from './narrative-migration-job.js';
import {
  abandonNarrativeMigration,
  refreshNarrativeMigration,
} from './narrative-migration-state.js';

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

it('rejects a stale second driver while retaining the saved policy across config changes', () => {
  const initial = beginNarrativeMigration(store.db, { cohortId: 'cohort', policy, now: NOW });
  const other = new SqliteStore({ filePath: path });
  try {
    expect(advanceNarrativeMigration(other.db, initial, 'graph', 'first', NOW)).toBe(true);
    expect(advanceNarrativeMigration(store.db, initial, 'complete', 'stale', NOW)).toBe(false);
    const held = readNarrativeMigration(store.db, 'cohort');
    expect(held).toMatchObject({ phase: 'graph', cursor: 'first' });
    expect(
      beginNarrativeMigration(store.db, {
        cohortId: 'cohort',
        policy: { ...policy, maxMembers: 25 },
        now: NOW,
      }),
    ).toEqual(held);
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

it('holds at the capture bound before persisting an overflowing page', () => {
  recordIngest(store.db, 'overflow', NOW);
  const job = beginNarrativeMigration(store.db, { cohortId: 'bounded', policy, now: NOW });
  store.db
    .prepare(
      `WITH RECURSIVE positions(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM positions WHERE n < ?)
    INSERT INTO narrative_migration_capture (cohort_id, source_id, archive_seen, graph_seen)
    SELECT 'bounded', 'captured-' || n, 1, 0 FROM positions`,
    )
    .run(MIGRATION_COHORT_LIMIT);
  captureNarrativeMigrationPage(store.db, job, ['overflow'], 'past-bound', NOW);
  const row = store.db
    .prepare('SELECT COUNT(*) AS n FROM narrative_migration_capture WHERE cohort_id = ?')
    .get('bounded') as { n: number };
  expect(row.n).toBe(MIGRATION_COHORT_LIMIT);
  expect(readNarrativeMigration(store.db, 'bounded')).toMatchObject({
    state: 'blocked',
    cursor: '',
    blockedReason: 'capture_member_bound',
  });
});

it('releases frozen reservations on abandonment and rejects the stale runner', () => {
  const job = beginNarrativeMigration(store.db, { cohortId: 'retired-job', policy, now: NOW });
  captureNarrativeMigrationPage(store.db, job, ['old'], 'captured', NOW);
  const captured = readNarrativeMigration(store.db, job.cohortId)!;
  advanceNarrativeMigration(store.db, captured, 'graph', '', NOW);
  freezeNarrativeMigrationCapture(store.db, readNarrativeMigration(store.db, job.cohortId)!, NOW);
  const frozen = readNarrativeMigration(store.db, job.cohortId)!;
  expect(sourceReservedForMigration(store.db, 'old')).toBe(true);
  expect(abandonNarrativeMigration(store.db, job.cohortId, NOW)).toBe('abandoned');
  expect(sourceReservedForMigration(store.db, 'old')).toBe(false);
  expect(advanceNarrativeMigration(store.db, frozen, 'order', 'stale', NOW)).toBe(false);
  expect(
    refreshNarrativeMigration(store.db, readNarrativeMigration(store.db, job.cohortId)!, NOW),
  ).toBe(false);
  expect(readMigrationCohort(store.db, job.cohortId)).toBeDefined();
  expect(countMigrationProgress(store.db, job.cohortId).accounted).toBe(1);
  store.close();
  store = new SqliteStore({ filePath: path });
  expect(readNarrativeMigration(store.db, job.cohortId)?.state).toBe('abandoned');
});

it('refuses a partition policy that conflicts with an older frozen cohort', () => {
  freezeMigrationCohort(store.db, {
    cohortId: 'older',
    cohortDigest: 'old',
    intakeWatermark: 1,
    archiveRowidLow: 0,
    archiveRowidHigh: 0,
    graphCensusDigest: 'old',
    orderingPolicyVersion: 2,
    createdAt: NOW,
    members: ['old'],
  });
  expect(() => beginNarrativeMigration(store.db, { cohortId: 'older', policy, now: NOW })).toThrow(
    'migration_ordering_policy_mismatch',
  );
  expect(readNarrativeMigration(store.db, 'older')).toBeUndefined();
  expect(
    store.db
      .prepare('SELECT partition_policy_json FROM migration_cohorts WHERE cohort_id = ?')
      .get('older'),
  ).toEqual({ partition_policy_json: null });
});

it('rechecks ingest positions at freeze while preserving genuine legacy members', () => {
  const initial = beginNarrativeMigration(store.db, { cohortId: 'freeze', policy, now: NOW });
  captureNarrativeMigrationPage(
    store.db,
    initial,
    ['old', 'legacy', 'late-position'],
    'captured',
    NOW,
  );
  advanceNarrativeMigration(
    store.db,
    readNarrativeMigration(store.db, 'freeze')!,
    'graph',
    '',
    NOW,
  );
  recordIngest(store.db, 'late-position', NOW);
  expect(
    freezeNarrativeMigrationCapture(store.db, readNarrativeMigration(store.db, 'freeze')!, NOW),
  ).toBe(true);
  expect(
    store.db
      .prepare('SELECT source_id FROM migration_progress WHERE cohort_id = ? ORDER BY source_id')
      .all('freeze'),
  ).toEqual([{ source_id: 'legacy' }, { source_id: 'old' }]);
  expect(sourceReservedForMigration(store.db, 'late-position')).toBe(false);
  expect(sourceReservedForMigration(store.db, 'legacy')).toBe(true);
  expect(
    store.db
      .prepare(
        'SELECT source_id FROM narrative_migration_capture WHERE cohort_id = ? AND source_id = ?',
      )
      .get('freeze', 'late-position'),
  ).toBeDefined();
});
