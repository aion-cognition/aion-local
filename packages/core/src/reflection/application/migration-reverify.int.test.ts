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

it('can re-prove the full frozen denominator after selective refresh has completed', async () => {
  const target = await acceptSource('full-reverify', 'source whose projection later drifts', false);
  const neighbor = await acceptSource('full-reverify', 'healthy source', false);
  const options = { cohortId: 'full-reverify', policy, now: NOW, steps: 128, batchWallMs: 60000 };
  expect((await runNarrativeMigrationBatch(chunks, options)).complete).toBe(true);
  expect((await runNarrativeMigrationBatch(chunks, { ...options, refresh: true })).complete).toBe(
    true,
  );
  await driftEpisodeDigest(driver, target, 'drift-after-selective-refresh');
  expect(readSourceRecord(store.db, target)?.verificationStatus).toBe('verified');
  const producer = vi.spyOn(backfill, 'runLegacyBackfillBatch');
  const result = await runNarrativeMigrationBatch(chunks, { ...options, reverify: true });
  expect(producer.mock.calls.flatMap((call) => call[1].sourceIds ?? []).sort()).toEqual(
    [target, neighbor].sort(),
  );
  expect(result.complete).toBe(false);
  expect(readSourceRecord(store.db, target)?.verificationStatus).toBe('pinned');
});
