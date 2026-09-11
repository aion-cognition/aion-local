import { afterEach, expect, it, vi } from 'vitest';

import * as backfill from './legacy-backfill.js';
import { runNarrativeMigrationBatch } from './narrative-migration.js';
import { narrativePublication } from './narrative-publication.js';
import { acceptSource, chunks, NOW, store } from './test-support/t10b-review.fixture.js';
import { chunkOfSource } from '../../infrastructure/sqlite/chunk-manifest.js';
import { readNarrativeMigration } from '../../infrastructure/sqlite/narrative-migration-job.js';
import { CHUNK_BOUNDARY_POLICY } from '../domain/chunk-boundary.js';

const policy = { ...CHUNK_BOUNDARY_POLICY, partitionPolicyVersion: 1 };
afterEach(() => {
  vi.restoreAllMocks();
});

it('holds after three actual failed publication attempts while polls consume no retry budget', async () => {
  const source = await acceptSource(
    'retry-limit',
    'unchanged input that the provider keeps rejecting',
    false,
  );
  const options = { cohortId: 'retry-limit', policy, now: NOW, steps: 64, batchWallMs: 60000 };
  for (
    let step = 0;
    step < 64 && readNarrativeMigration(store.db, options.cohortId)?.phase !== 'publish';
    step += 1
  ) {
    await runNarrativeMigrationBatch(chunks, { ...options, steps: 1 });
  }
  expect(readNarrativeMigration(store.db, options.cohortId)?.phase).toBe('publish');
  const producer = vi.spyOn(backfill, 'runLegacyBackfillBatch');
  const generate = vi
    .spyOn(chunks.provider, 'generate')
    .mockRejectedValue(new Error('same provider failure'));
  let now = NOW;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await runNarrativeMigrationBatch(chunks, { ...options, now });
    expect(generate).toHaveBeenCalledTimes(attempt);
    if (attempt < 3) {
      expect(result.state, JSON.stringify(result)).toBe('running');
      expect(result.stopped).toBe('publication_retry_wait');
      const retryAt = readNarrativeMigration(store.db, options.cohortId)!.retryAt!;
      for (let poll = 0; poll < 3; poll += 1) {
        expect((await runNarrativeMigrationBatch(chunks, { ...options, now })).state).toBe(
          'running',
        );
      }
      expect(generate).toHaveBeenCalledTimes(attempt);
      now = new Date(retryAt);
    } else {
      expect(result.state, JSON.stringify(result)).toBe('blocked');
      expect(result.stopped).toBe('publication_retry_exhausted');
      expect(result.issues).toContainEqual({
        id: chunkOfSource(store.db, source),
        reason: 'synthesis_failed',
      });
      expect(result.retryAt).toBeUndefined();
    }
  }
  expect((await runNarrativeMigrationBatch(chunks, { ...options, now })).steps).toBe(0);
  generate.mockRestore();
  const repaired = await runNarrativeMigrationBatch(chunks, { ...options, now, refresh: true });
  expect(repaired.complete, JSON.stringify(repaired)).toBe(true);
  expect(producer).not.toHaveBeenCalled();
});

it('keeps the retry budget across fresh revision numbers after guarded deferrals', async () => {
  const source = await acceptSource(
    'deferred-limit',
    'unchanged source under repeated publication deferral',
    false,
  );
  const options = { cohortId: 'deferred-limit', policy, now: NOW, steps: 64, batchWallMs: 60000 };
  for (
    let step = 0;
    step < 64 && readNarrativeMigration(store.db, options.cohortId)?.phase !== 'publish';
    step += 1
  ) {
    await runNarrativeMigrationBatch(chunks, { ...options, steps: 1 });
  }
  expect(readNarrativeMigration(store.db, options.cohortId)?.phase).toBe('publish');
  const check = vi
    .spyOn(narrativePublication, 'check')
    .mockResolvedValue({ status: 'deferred', reason: 'dependency_moved' });
  let now = NOW;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await runNarrativeMigrationBatch(chunks, { ...options, now });
    if (attempt < 3) {
      expect(result.state, JSON.stringify(result)).toBe('running');
      now = new Date(result.retryAt!);
    } else {
      expect(result.state, JSON.stringify(result)).toBe('blocked');
      expect(result.stopped).toBe('publication_retry_exhausted');
    }
  }
  expect(check).toHaveBeenCalledTimes(3);
  const rows = store.db
    .prepare(
      'SELECT revision_no, attempts FROM chunk_revisions WHERE chunk_id = ? ORDER BY revision_no',
    )
    .all(chunkOfSource(store.db, source)) as { revision_no: number; attempts: number }[];
  expect(rows.length).toBeGreaterThan(3);
  expect(Math.max(...rows.map((row) => row.attempts))).toBe(1);
});
