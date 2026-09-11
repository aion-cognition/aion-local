import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';

import * as backfill from './legacy-backfill.js';
import { runNarrativeMigrationBatch } from './narrative-migration.js';
import {
  acceptSource,
  chunks,
  dropCensus,
  NOW,
  store,
} from './test-support/t10b-review.fixture.js';
import { chunkOfSource } from '../../infrastructure/sqlite/chunk-manifest.js';
import { readNarrativeMigration } from '../../infrastructure/sqlite/narrative-migration-job.js';
import { readMigrationIssues } from '../../infrastructure/sqlite/narrative-migration-pass.js';
import * as coverage from '../../recall/application/coverage-checker.js';
import { CHUNK_BOUNDARY_POLICY } from '../domain/chunk-boundary.js';

const policy = { ...CHUNK_BOUNDARY_POLICY, partitionPolicyVersion: 1 };
async function reachPublish(cohortId: string): Promise<void> {
  for (
    let step = 0;
    step < 128 && readNarrativeMigration(store.db, cohortId)?.phase !== 'publish';
    step += 1
  ) {
    const result = await runNarrativeMigrationBatch(chunks, {
      cohortId,
      policy,
      now: NOW,
      steps: 1,
      batchWallMs: 60000,
    });
    expect(result.stopped, JSON.stringify(result)).toBeUndefined();
  }
  expect(readNarrativeMigration(store.db, cohortId)?.phase).toBe('publish');
}
afterEach(() => {
  vi.restoreAllMocks();
});

it('schedules a provider failure itself and recovers after the due time without source re-verification', async () => {
  const source = await acceptSource('timed-provider', 'source to narrate', false);
  await reachPublish('timed-provider');
  const producer = vi.spyOn(backfill, 'runLegacyBackfillBatch');
  const generation = vi
    .spyOn(chunks.provider, 'generate')
    .mockRejectedValue(new Error('provider unavailable'));
  const options = { cohortId: 'timed-provider', policy, now: NOW, steps: 64, batchWallMs: 60000 };
  const failed = await runNarrativeMigrationBatch(chunks, options);
  expect(failed.state, JSON.stringify(failed)).toBe('running');
  expect(failed.stopped).toBe('publication_retry_wait');
  expect(generation).toHaveBeenCalledTimes(1);
  const retry = store.db
    .prepare(
      "SELECT next_attempt_at FROM chunk_revisions WHERE chunk_id = ? AND state = 'allocated'",
    )
    .get(chunkOfSource(store.db, source)) as { next_attempt_at: string | null };
  expect(retry.next_attempt_at).not.toBeNull();
  expect(new Date(retry.next_attempt_at!).getTime()).toBeGreaterThan(NOW.getTime());
  await runNarrativeMigrationBatch(chunks, options);
  expect(generation).toHaveBeenCalledTimes(1);
  generation.mockRestore();
  const recovered = await runNarrativeMigrationBatch(chunks, {
    ...options,
    now: new Date(retry.next_attempt_at!),
  });
  expect(recovered.complete, JSON.stringify(recovered)).toBe(true);
  expect(producer).not.toHaveBeenCalled();
});

it('dates a pre-allocation coverage refusal without inventing a revision or immediately retrying', async () => {
  await acceptSource('timed-coverage', 'source held by coverage availability', false);
  await reachPublish('timed-coverage');
  const empty = new Database(':memory:');
  const refused = coverage.checkPresentCoverage(empty, NOW);
  empty.close();
  expect(refused.status).toBe('refused');
  const check = vi.spyOn(coverage, 'checkPresentCoverage').mockReturnValue(refused);
  const generation = vi.spyOn(chunks.provider, 'generate');
  const options = { cohortId: 'timed-coverage', policy, now: NOW, steps: 64, batchWallMs: 60000 };
  const before = store.db.prepare('SELECT COUNT(*) AS n FROM chunk_revisions').get();
  const failed = await runNarrativeMigrationBatch(chunks, options);
  expect(store.db.prepare('SELECT COUNT(*) AS n FROM chunk_revisions').get()).toEqual(before);
  expect(failed.state, JSON.stringify(failed)).toBe('running');
  expect(failed.stopped).toBe('publication_retry_wait');
  const held = readNarrativeMigration(store.db, options.cohortId)!;
  const retry = (held as typeof held & { retryAt?: string }).retryAt;
  expect(retry).toBeDefined();
  expect(generation).not.toHaveBeenCalled();
  await runNarrativeMigrationBatch(chunks, options);
  expect(check).toHaveBeenCalledTimes(1);
  check.mockRestore();
  const producer = vi.spyOn(backfill, 'runLegacyBackfillBatch');
  const recovered = await runNarrativeMigrationBatch(chunks, { ...options, now: new Date(retry!) });
  expect(recovered.complete, JSON.stringify(recovered)).toBe(true);
  expect(producer).not.toHaveBeenCalled();
});

it('keeps the chunk prerequisite in the hold record and refreshes it without re-verifying completed sources', async () => {
  const source = await acceptSource(
    'blocked-census',
    'source whose census will need renewal',
    false,
  );
  await reachPublish('blocked-census');
  dropCensus(source);
  const producer = vi.spyOn(backfill, 'runLegacyBackfillBatch');
  const options = { cohortId: 'blocked-census', policy, now: NOW, steps: 64, batchWallMs: 60000 };
  const held = await runNarrativeMigrationBatch(chunks, options);
  expect(held.state, JSON.stringify(held)).toBe('blocked');
  expect(readMigrationIssues(store.db, options.cohortId).issues).toContainEqual({
    id: chunkOfSource(store.db, source),
    reason: 'member_scope_census_missing',
  });
  const recovered = await runNarrativeMigrationBatch(chunks, { ...options, refresh: true });
  expect(recovered.complete, JSON.stringify(recovered)).toBe(true);
  expect(producer).not.toHaveBeenCalled();
});
