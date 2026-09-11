import { afterEach, expect, it, vi } from 'vitest';

import * as backfill from './legacy-backfill.js';
import { runNarrativeMigrationBatch } from './narrative-migration.js';
import { acceptSource, chunks, driver, NOW, store } from './test-support/t10b-review.fixture.js';
import { driftEpisodeDigest } from '../../infrastructure/graph/test-support/legacy-corpus.fixture.js';
import { readSourceRecord } from '../../infrastructure/sqlite/source-identity.js';
import { CHUNK_BOUNDARY_POLICY } from '../domain/chunk-boundary.js';

const policy = { ...CHUNK_BOUNDARY_POLICY, partitionPolicyVersion: 1 };
afterEach(() => {
  vi.restoreAllMocks();
});

it('re-verifies the pinned member on refresh and retains completed verification for its neighbors', async () => {
  const target = await acceptSource('selective-repair', 'source temporarily failing proof', false);
  await acceptSource('selective-repair', 'healthy neighbor', false);
  const original = readSourceRecord(store.db, target)!.verifiedContentDigest!;
  await driftEpisodeDigest(driver, target, 'temporary-digest-mismatch');
  const options = {
    cohortId: 'selective-repair',
    policy,
    now: NOW,
    steps: 128,
    batchWallMs: 60000,
  };
  const held = await runNarrativeMigrationBatch(chunks, options);
  expect(held.state, JSON.stringify(held)).toBe('blocked');
  expect(held.stopped).toBe('cohort_not_fully_accounted');
  await driftEpisodeDigest(driver, target, original);
  const producer = vi.spyOn(backfill, 'runLegacyBackfillBatch');
  const recovered = await runNarrativeMigrationBatch(chunks, { ...options, refresh: true });
  expect(recovered.complete, JSON.stringify(recovered)).toBe(true);
  expect(producer).toHaveBeenCalledTimes(1);
  expect(producer.mock.calls[0]?.[1].sourceIds).toEqual([target]);
});
