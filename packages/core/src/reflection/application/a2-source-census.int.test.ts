import { expect, it } from 'vitest';

import { incomingStatementScopes, memberScopesCounted } from './chunk-evidence.js';
import {
  freezeLegacyCohort,
  runLegacyBackfillBatch,
  sealLegacyCohortCensus,
} from './legacy-backfill.js';
import { acceptSource, chunks, driver, NOW, store } from './test-support/t10b-review.fixture.js';

it('establishes the source scopes a historical chunk needs through the real cohort producer', async () => {
  const sourceId = await acceptSource('migration-source-census', 'legacy raw evidence', false);
  const deps = { driver, db: store.db, publications: chunks.publications };
  const cohortId = 'migration-source-census';
  await freezeLegacyCohort(deps, { cohortId, now: NOW });
  const walked = await runLegacyBackfillBatch(deps, { cohortId, now: NOW });
  expect(walked.pinned).toBe(0);
  expect(walked.remaining).toBe(0);
  const sealed = await sealLegacyCohortCensus(deps, { cohortId });
  expect(sealed.deferred).toBeUndefined();
  console.log(
    JSON.stringify({ walked, sealed, sourceScopes: incomingStatementScopes(store.db, sourceId) }),
  );
  expect(memberScopesCounted(store.db, [sourceId])).toBe(true);
});
