import { afterEach, expect, it, vi } from 'vitest';

import * as census from './accepted-source-census.js';
import { INCOMING_STATEMENT_SCOPES, incomingStatementScopes } from './chunk-evidence.js';
import {
  freezeLegacyCohort,
  runLegacyBackfillBatch,
  sealLegacyCohortCensus,
} from './legacy-backfill.js';
import * as records from './legacy-records.js';
import { acceptSource, chunks, driver, NOW, store } from './test-support/t10b-review.fixture.js';

afterEach(() => {
  vi.restoreAllMocks();
});

it('revisits a previously sealed source whose newly required incoming scopes are absent', async () => {
  const prepare = vi.spyOn(census, 'prepareSourceCensus').mockImplementation(() => undefined);
  const acknowledge = vi.spyOn(census, 'acknowledgeSourceCensus').mockReturnValue(0);
  const discard = vi.spyOn(census, 'discardSourceCensus').mockImplementation(() => undefined);
  let sourceId: string;
  try {
    sourceId = await acceptSource('previously-sealed', 'accepted before census upgrade', false);
  } finally {
    prepare.mockRestore();
    acknowledge.mockRestore();
    discard.mockRestore();
  }
  const deps = { driver, db: store.db, publications: chunks.publications };
  const cohortId = 'previously-sealed';
  await freezeLegacyCohort(deps, { cohortId, now: NOW });
  const walked = await runLegacyBackfillBatch(deps, { cohortId, now: NOW });
  expect(walked).toMatchObject({ remaining: 0, pinned: 0 });
  expect(records.isNodeEndpoint(store.db, sourceId)).toBe(false);

  // Reproduce the preceding selector while its real guarded seal establishes the old scopes.
  const select = records.endpointCensusScopes;
  const oldSelector = vi.spyOn(records, 'endpointCensusScopes').mockImplementation((db, id) => {
    const scopes = select(db, id);
    return id === sourceId
      ? scopes.filter((scope) => !INCOMING_STATEMENT_SCOPES.includes(scope))
      : scopes;
  });
  try {
    expect((await sealLegacyCohortCensus(deps, { cohortId })).deferred).toBeUndefined();
  } finally {
    oldSelector.mockRestore();
  }
  const oldScopes = store.db
    .prepare('SELECT census_status FROM evidence_scope_versions WHERE endpoint_id = ?')
    .all(sourceId) as { census_status: string }[];
  expect(oldScopes.length).toBeGreaterThan(0);
  expect(oldScopes.every((row) => row.census_status === 'established')).toBe(true);
  expect(incomingStatementScopes(store.db, sourceId).unproved).toHaveLength(2);

  // The upgraded selector must be reachable without resetting counters or deleting any evidence.
  expect((await sealLegacyCohortCensus(deps, { cohortId })).deferred).toBeUndefined();
  expect.soft(incomingStatementScopes(store.db, sourceId).unproved).toEqual([]);

  // A fresh cohort must not inherit the same blind spot through the preserved established bits.
  const next = 'previously-sealed-again';
  await freezeLegacyCohort(deps, { cohortId: next, now: NOW });
  expect(await runLegacyBackfillBatch(deps, { cohortId: next, now: NOW })).toMatchObject({
    remaining: 0,
    pinned: 0,
  });
  expect((await sealLegacyCohortCensus(deps, { cohortId: next })).deferred).toBeUndefined();
  expect.soft(incomingStatementScopes(store.db, sourceId).unproved).toEqual([]);

  // Nomination alone is enough: the real guarded proof already knows how to establish these.
  const nominate = records.pageUncountedEndpoints;
  const nomination = vi
    .spyOn(records, 'pageUncountedEndpoints')
    .mockImplementation((db, cohort, after, limit) => {
      const existing = nominate(db, cohort, after, limit);
      return [...new Set([...existing, ...(sourceId > after ? [sourceId] : [])])]
        .sort()
        .slice(0, limit);
    });
  try {
    expect((await sealLegacyCohortCensus(deps, { cohortId: next })).deferred).toBeUndefined();
    expect(incomingStatementScopes(store.db, sourceId).unproved).toEqual([]);
  } finally {
    nomination.mockRestore();
  }
});
