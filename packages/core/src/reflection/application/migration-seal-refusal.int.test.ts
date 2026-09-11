import { afterEach, expect, it, vi } from 'vitest';

import { runNarrativeMigrationBatch } from './narrative-migration.js';
import { acceptSource, chunks, NOW, store } from './test-support/t10b-review.fixture.js';
import { chunkOfSource } from '../../infrastructure/sqlite/chunk-manifest.js';
import { readNarrativeMigration } from '../../infrastructure/sqlite/narrative-migration-job.js';
import * as boundary from '../domain/chunk-boundary.js';

afterEach(() => {
  vi.restoreAllMocks();
});
it('records a late seal refusal and continues to the next session', async () => {
  const first = await acceptSource(
    'seal-refused-first',
    'member whose proof changes at sealing',
    false,
  );
  const later = [
    await acceptSource('seal-later', 'later member one', false),
    await acceptSource('seal-later', 'later member two', false),
  ];
  const options = {
    cohortId: 'seal-refusal',
    policy: { ...boundary.CHUNK_BOUNDARY_POLICY, partitionPolicyVersion: 1 },
    now: NOW,
    steps: 1,
    betweenStepsMs: 60000,
  };
  for (
    let attempt = 0;
    attempt < 64 && readNarrativeMigration(store.db, options.cohortId)?.phase !== 'partition';
    attempt += 1
  ) {
    const report = await runNarrativeMigrationBatch(chunks, options);
    expect(report.stopped, JSON.stringify(report)).toBeUndefined();
  }
  expect(readNarrativeMigration(store.db, options.cohortId)?.phase).toBe('partition');
  const original = boundary.decideChunkSeal;
  let withdrawn = false;
  vi.spyOn(boundary, 'decideChunkSeal').mockImplementation((input) => {
    const result = original(input);
    if (
      !withdrawn &&
      result.action === 'seal' &&
      result.members.some((member) => member.sourceId === first)
    ) {
      withdrawn = true;
      store.db
        .prepare(
          "UPDATE source_records SET verification_status = 'pinned', verification_reason = 'withdrawn at seal' WHERE source_id = ?",
        )
        .run(first);
    }
    return result;
  });
  const report = await runNarrativeMigrationBatch(chunks, { ...options, steps: 32 });
  expect(withdrawn).toBe(true);
  expect(report.issues.some((issue) => issue.id === first)).toBe(true);
  expect(later.every((id) => chunkOfSource(store.db, id) !== undefined)).toBe(true);
});
