import { afterEach, expect, it, vi } from 'vitest';

import { intakePublication } from './intake-publication.js';
import { runLegacyBackfillBatch } from './legacy-backfill.js';
import { runNarrativeMigrationBatch } from './narrative-migration.js';
import {
  acceptSource,
  chunks,
  driver,
  NOW,
  sessionOf,
  store,
  publications,
} from './test-support/t10b-review.fixture.js';
import { driftEpisodeDigest } from '../../infrastructure/graph/test-support/legacy-corpus.fixture.js';
import { sealChunk, chunkOfSource } from '../../infrastructure/sqlite/chunk-manifest.js';
import { readIngestPosition } from '../../infrastructure/sqlite/migration-cohorts.js';
import {
  readNarrativeMigration,
  beginNarrativeMigration,
  captureNarrativeMigrationPage,
} from '../../infrastructure/sqlite/narrative-migration-job.js';
import { CHUNK_BOUNDARY_POLICY } from '../domain/chunk-boundary.js';

const policy = { ...CHUNK_BOUNDARY_POLICY, partitionPolicyVersion: 1 };
afterEach(() => {
  vi.restoreAllMocks();
});

it('continues past a pre-sealed session whose other member fails verification', async () => {
  const first = await acceptSource('adoption-blocked', 'healthy adopted member', false);
  const bad = await acceptSource('adoption-blocked', 'member with withdrawn proof', false);
  sealChunk(store.db, { sessionId: sessionOf(first), sourceIds: [first, bad], sealedAt: NOW });
  const later = [];
  for (let index = 0; index < 3; index += 1) {
    later.push(
      await acceptSource('later-larger-session', `later verified member ${String(index)}`, false),
    );
  }
  const options = {
    cohortId: 'adoption-blocked',
    policy,
    now: NOW,
    steps: 1,
    betweenStepsMs: 60000,
  };
  for (
    let attempt = 0;
    attempt < 64 && readNarrativeMigration(store.db, options.cohortId)?.phase !== 'partition';
    attempt += 1
  ) {
    const step = await runNarrativeMigrationBatch(chunks, options);
    expect(step.stopped, JSON.stringify(step)).toBeUndefined();
  }
  expect(readNarrativeMigration(store.db, options.cohortId)?.phase).toBe('partition');
  await driftEpisodeDigest(driver, bad, 'not-the-archived-digest');
  expect(
    (
      await runLegacyBackfillBatch(chunks, {
        cohortId: options.cohortId,
        now: NOW,
        reverify: true,
        sourceIds: [bad],
        limit: 1,
      })
    ).pinned,
  ).toBe(1);
  const report = await runNarrativeMigrationBatch(chunks, { ...options, steps: 32 });
  expect(report.issues.length).toBeGreaterThan(0);
  expect(
    later.every((id) => chunkOfSource(store.db, id) !== undefined),
    JSON.stringify(report),
  ).toBe(true);
});

it('has a durable intake position before graph commit awaits acknowledgment', async () => {
  const job = beginNarrativeMigration(store.db, {
    cohortId: 'intake-publication-window',
    policy,
    now: NOW,
  });
  let position: number | undefined;
  let sourceId = '';
  const stop = vi
    .spyOn(intakePublication, 'acknowledgeSqlite')
    .mockImplementation((context, plan) => {
      const data = plan.data as { sourceId: string };
      ({ sourceId } = data);
      position = readIngestPosition(context.db, sourceId);
      throw new Error('stop at acknowledgment');
    });
  await expect(
    acceptSource('intake-publication-window', 'accepted after capture boundary', false),
  ).rejects.toThrow();
  stop.mockRestore();
  console.log(
    JSON.stringify({
      phase: 'before-ack',
      watermark: job.intakeWatermark,
      durableIngestPosition: position,
      sourceId,
    }),
  );
  expect(position).toBeGreaterThan(job.intakeWatermark);
  expect(readIngestPosition(store.db, sourceId)).toBe(position);
  expect(publications.hasPending()).toBe(true);
  captureNarrativeMigrationPage(store.db, job, [sourceId], 'examined', NOW);
  expect(
    store.db
      .prepare('SELECT source_id FROM narrative_migration_capture WHERE cohort_id = ?')
      .all(job.cohortId),
  ).toEqual([]);
  expect((await publications.recover())?.status).toBe('acknowledged');
});
