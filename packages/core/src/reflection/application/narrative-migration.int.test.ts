import { expect, it } from 'vitest';

import { sealSessionChunk } from './chunk-narrative.js';
import {
  runNarrativeMigrationBatch,
  type NarrativeMigrationReport,
} from './narrative-migration.js';
import {
  acceptSource,
  chunks,
  driver,
  NOW,
  sessionOf,
  store,
} from './test-support/t10b-review.fixture.js';
import {
  seedLegacyFamilyVersion,
  setSourceCaptureClock,
} from '../../infrastructure/graph/test-support/family-cutover.fixture.js';
import {
  chunkOfSource,
  listSessionChunks,
  readRemainderMembers,
} from '../../infrastructure/sqlite/chunk-manifest.js';
import { dueChunkGroups } from '../../infrastructure/sqlite/chunk-nomination.js';
import { readFamilySelection } from '../../infrastructure/sqlite/family-selection.js';
import { readMigrationProgress } from '../../infrastructure/sqlite/migration-cohorts.js';
import { readNarrativeMigration } from '../../infrastructure/sqlite/narrative-migration-job.js';
import { CHUNK_BOUNDARY_POLICY } from '../domain/chunk-boundary.js';

const POLICY = { ...CHUNK_BOUNDARY_POLICY, maxMembers: 2, partitionPolicyVersion: 1 };

it('resumes a fixed partition while late backdated intake keeps its own live path', async () => {
  const left = await acceptSource('migration-fixed-session', 'earlier original', false);
  const right = await acceptSource('migration-fixed-session', 'later original', false);
  const sessionId = sessionOf(left);
  expect(sessionOf(right)).toBe(sessionId);
  await seedLegacyFamilyVersion(driver, {
    nodeId: 'migration-fixed-overview',
    sessionId,
    sources: [left, right],
    now: NOW,
  });
  const options = {
    cohortId: 'migration-fixed',
    policy: POLICY,
    now: NOW,
    steps: 1,
    pageSize: 1,
    betweenStepsMs: 60_000,
  };
  const first = await runNarrativeMigrationBatch(chunks, options);
  expect(first.cohort.status).toBe('capturing');
  expect(readRemainderMembers(store.db, sessionId, 10)).toEqual([]);

  const tail = await acceptSource(
    'migration-fixed-session',
    'backdated new arrival',
    false,
    new Date(NOW.getTime() - 172_800_000),
  );
  expect(readRemainderMembers(store.db, sessionId, 10).map((row) => row.sourceId)).toEqual([tail]);
  const live = await sealSessionChunk(chunks, sessionId, { now: NOW, sessionClosing: true });
  expect(live.status).toBe('sealed');
  if (live.status !== 'sealed') {
    throw new Error('live tail did not seal');
  }
  let progress: NarrativeMigrationReport = first;
  let comparedBudgets = false;
  for (let iteration = 0; iteration < 100 && !progress.complete; iteration += 1) {
    progress = await runNarrativeMigrationBatch(chunks, options);
    if (readNarrativeMigration(store.db, options.cohortId)?.phase === 'publish') {
      const historical = chunkOfSource(store.db, left);
      if (historical !== undefined) {
        const due = dueChunkGroups(store.db, NOW, 100).map((row) => row.chunkId);
        expect(due).toContain(live.chunkId);
        expect(due).not.toContain(historical);
        comparedBudgets = true;
      }
    }
  }
  expect(progress.complete, JSON.stringify(progress)).toBe(true);
  expect(comparedBudgets).toBe(true);
  expect(readMigrationProgress(store.db, options.cohortId, tail)).toBeUndefined();
  expect(readMigrationProgress(store.db, options.cohortId, left)?.partitionAssignment).toBe(
    chunkOfSource(store.db, left),
  );
  expect(readMigrationProgress(store.db, options.cohortId, right)?.partitionAssignment).toBe(
    chunkOfSource(store.db, left),
  );
  expect(chunkOfSource(store.db, tail)).toBe(live.chunkId);
  expect(readFamilySelection(store.db, sessionId)?.family).toBe('chunk');
  const before = JSON.stringify(listSessionChunks(store.db, sessionId));
  expect((await runNarrativeMigrationBatch(chunks, options)).steps).toBe(0);
  expect(JSON.stringify(listSessionChunks(store.db, sessionId))).toBe(before);
});

it('keeps an unproved capture clock as a separate gap and repairs it without repartitioning', async () => {
  const sourceId = await acceptSource(
    'migration-order-gap',
    'record with no original clock',
    false,
  );
  await setSourceCaptureClock(driver, sourceId, null);
  store.db
    .prepare('UPDATE experience_archive SET archived_at = ? WHERE episode_id = ?')
    .run('not-a-clock', sourceId);
  const options = {
    cohortId: 'migration-order-gap',
    policy: POLICY,
    now: NOW,
    steps: 64,
    betweenStepsMs: 60_000,
  };
  let progress = await runNarrativeMigrationBatch(chunks, options);
  expect(progress.complete).toBe(false);
  const gap = store.db
    .prepare(
      'SELECT status, capture_order_value, partition_gap FROM migration_progress WHERE cohort_id = ? AND source_id = ?',
    )
    .get(options.cohortId, sourceId);
  expect(gap).toEqual({
    status: 'verified',
    capture_order_value: null,
    partition_gap: 'capture_order_unproved',
  });
  expect(progress.cohort).toMatchObject({ status: 'frozen', partitionGaps: 1 });
  expect(chunkOfSource(store.db, sourceId)).toBeUndefined();

  await setSourceCaptureClock(driver, sourceId, NOW.toISOString());
  progress = await runNarrativeMigrationBatch(chunks, { ...options, refresh: true });
  for (let attempt = 0; attempt < 10 && !progress.complete; attempt += 1) {
    progress = await runNarrativeMigrationBatch(chunks, options);
  }
  expect(progress.complete, JSON.stringify(progress)).toBe(true);
  expect(chunkOfSource(store.db, sourceId)).toBeDefined();
  expect(
    store.db
      .prepare(
        'SELECT capture_order_basis, partition_gap FROM migration_progress WHERE cohort_id = ? AND source_id = ?',
      )
      .get(options.cohortId, sourceId),
  ).toEqual({ capture_order_basis: 'graph_tx_from', partition_gap: null });
});
