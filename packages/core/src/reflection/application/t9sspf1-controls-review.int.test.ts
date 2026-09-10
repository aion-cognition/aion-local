import { expect, it } from 'vitest';

import { INCOMING_STATEMENT_SCOPES, incomingStatementScopes } from './chunk-evidence.js';
import {
  freezeLegacyCohort,
  runLegacyBackfillBatch,
  sealLegacyCohortCensus,
} from './legacy-backfill.js';
import { acceptSource, chunks, driver, NOW, store } from './test-support/t10b-review.fixture.js';
import {
  driftEpisodeDigest,
  seedGraphOnlyEpisode,
} from '../../infrastructure/graph/test-support/legacy-corpus.fixture.js';
import {
  ARCHIVE_SCHEMA_VERSION,
  insertExperience,
} from '../../infrastructure/sqlite/experience-archive.js';
import { readMigrationProgress } from '../../infrastructure/sqlite/migration-cohorts.js';
import { readSourceRecord } from '../../infrastructure/sqlite/source-identity.js';
import { prepareEpisode } from '../domain/content.js';

it('declares the new source censuses once and no census for a reused occurrence', async () => {
  const sourceId = await acceptSource('declared-source', 'the identical experience', false);
  const scopes = (): unknown[] => {
    const row = store.db
      .prepare(
        "SELECT affected_scopes_json FROM publication_intents WHERE kind = 'intake' ORDER BY sequence DESC LIMIT 1",
      )
      .get() as { affected_scopes_json: string };
    return JSON.parse(row.affected_scopes_json) as unknown[];
  };
  const incoming = INCOMING_STATEMENT_SCOPES.map((scope) => ({
    kind: 'relation_scope',
    id: sourceId,
    scope,
  }));
  expect(scopes()).toEqual(expect.arrayContaining(incoming));
  expect(await acceptSource('declared-source', 'the identical experience', false)).toBe(sourceId);
  for (const entry of incoming) {
    expect(scopes()).not.toContainEqual(entry);
  }
});

it('pins a relationship-free archive and graph source before it can claim full verification', async () => {
  const sourceId = 'relationship-free-legacy';
  const payload = { observations: ['the isolated legacy source'] };
  const prepared = prepareEpisode(payload, NOW);
  insertExperience(store.db, {
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    pipelineVersion: 'legacy',
    identity: 'relationship-free-member',
    sessionId: 'missing-session-link',
    episodeId: sourceId,
    contentHash: prepared.contentHash,
    occurredAt: NOW.toISOString(),
    archivedAt: NOW.toISOString(),
    payload,
  });
  await seedGraphOnlyEpisode(driver, {
    episodeId: sourceId,
    sessionId: 'missing-session-link',
    now: NOW,
  });
  await driftEpisodeDigest(driver, sourceId, prepared.contentHash);
  expect(readSourceRecord(store.db, sourceId)).toBeUndefined();
  const deps = { driver, db: store.db, publications: chunks.publications };
  const cohortId = 'relationship-free-cohort';
  await freezeLegacyCohort(deps, { cohortId, now: NOW });
  expect((await runLegacyBackfillBatch(deps, { cohortId, now: NOW })).pinned).toBe(1);
  expect(readMigrationProgress(store.db, cohortId, sourceId)).toMatchObject({ status: 'pinned' });
  expect(readMigrationProgress(store.db, cohortId, sourceId)?.reason).toContain('session none');
  expect((await sealLegacyCohortCensus(deps, { cohortId })).deferred).toBeDefined();
  expect(incomingStatementScopes(store.db, sourceId).unproved).toHaveLength(2);
});
