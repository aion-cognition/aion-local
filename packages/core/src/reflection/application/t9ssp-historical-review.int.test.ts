import { afterEach, expect, it, vi } from 'vitest';

import * as census from './accepted-source-census.js';
import { incomingStatementScopes, memberScopesCounted } from './chunk-evidence.js';
import {
  freezeLegacyCohort,
  runLegacyBackfillBatch,
  sealLegacyCohortCensus,
} from './legacy-backfill.js';
import { acceptSource, chunks, driver, NOW, store } from './test-support/t10b-review.fixture.js';

afterEach(() => {
  vi.restoreAllMocks();
});

it('repairs both incoming statement censuses for a source accepted before the producer existed', async () => {
  // The previous intake had all these writes except the three newly added census hooks.
  const prepare = vi.spyOn(census, 'prepareSourceCensus').mockImplementation(() => undefined);
  const acknowledge = vi.spyOn(census, 'acknowledgeSourceCensus').mockReturnValue(0);
  const discard = vi.spyOn(census, 'discardSourceCensus').mockImplementation(() => undefined);
  let sourceId: string;
  try {
    sourceId = await acceptSource('pre-producer-source', 'archived before source census', false);
  } finally {
    prepare.mockRestore();
    acknowledge.mockRestore();
    discard.mockRestore();
  }
  expect(memberScopesCounted(store.db, [sourceId])).toBe(false);
  const deps = { driver, db: store.db, publications: chunks.publications };
  const cohortId = 'pre-producer-cohort';
  await freezeLegacyCohort(deps, { cohortId, now: NOW });
  const walked = await runLegacyBackfillBatch(deps, { cohortId, now: NOW });
  expect(walked.remaining).toBe(0);
  expect(walked.pinned).toBe(0);
  const sealed = await sealLegacyCohortCensus(deps, { cohortId });
  expect(sealed.deferred).toBeUndefined();
  expect(incomingStatementScopes(store.db, sourceId).unproved).toEqual([]);
});
