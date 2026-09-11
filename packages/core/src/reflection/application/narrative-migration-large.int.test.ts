import { expect, it } from 'vitest';

import { INSTALLED_PUBLICATION_HANDLERS } from './installed-publications.js';
import { runNarrativeMigrationBatch } from './narrative-migration.js';
import {
  acceptSource,
  chunks,
  driver,
  NOW,
  sessionOf,
  store,
} from './test-support/t10b-review.fixture.js';
import { EvidenceResolver } from '../../evidence/application/resolver.js';
import { seedLegacyFamilyVersion } from '../../infrastructure/graph/test-support/family-cutover.fixture.js';
import {
  seedMigrationCorpus,
  type MigrationCorpusRow,
} from '../../infrastructure/graph/test-support/migration-corpus.fixture.js';
import { openLogger } from '../../infrastructure/logging/logger.js';
import { PublicationCoordinator } from '../../infrastructure/publication/coordinator.js';
import { listChunkMembers, listSessionChunks } from '../../infrastructure/sqlite/chunk-manifest.js';
import {
  ARCHIVE_SCHEMA_VERSION,
  insertExperience,
} from '../../infrastructure/sqlite/experience-archive.js';
import { readFamilySelection } from '../../infrastructure/sqlite/family-selection.js';
import { CHUNK_BOUNDARY_POLICY } from '../domain/chunk-boundary.js';
import { prepareEpisode } from '../domain/content.js';

it('carries a 914-source legacy session through bounded batches without rewriting its partition', async () => {
  const anchor = await acceptSource('large-migration', 'the first of 914 sources', false);
  const sessionId = sessionOf(anchor);
  const rows: MigrationCorpusRow[] = [];
  for (let index = 1; index < 914; index += 1) {
    const id = `legacy-914-${String(index).padStart(4, '0')}`;
    const capturedAt = new Date(NOW.getTime() + index * 1000).toISOString();
    const occurredAt = new Date(NOW.getTime() - 86_400_000 + index * 1000).toISOString();
    const text = `Historical observation number ${String(index)} remains attributable to its capture.`;
    const payload = { observations: [text] };
    const prepared = prepareEpisode(payload, new Date(occurredAt));
    insertExperience(store.db, {
      schemaVersion: ARCHIVE_SCHEMA_VERSION,
      pipelineVersion: 'legacy-fixture',
      identity: 'large-migration',
      sessionId,
      episodeId: id,
      contentHash: prepared.contentHash,
      occurredAt,
      archivedAt: capturedAt,
      payload,
    });
    rows.push({ id, text: prepared.text, hash: prepared.contentHash, occurredAt, capturedAt });
  }
  await seedMigrationCorpus(driver, sessionId, rows);
  const ids = [anchor, ...rows.map((row) => row.id)];
  await seedLegacyFamilyVersion(driver, {
    nodeId: 'legacy-914-overview',
    sessionId,
    sources: ids,
    now: NOW,
  });
  const now = new Date(NOW.getTime() + 7_200_000);
  const logger = openLogger({ filePath: '/dev/null', level: 'fatal' });
  const publications = new PublicationCoordinator({
    driver,
    db: store.db,
    logger,
    handlers: [...INSTALLED_PUBLICATION_HANDLERS],
    now: () => now,
  });
  await publications.initialize();
  const deps = {
    ...chunks,
    logger,
    publications,
    resolver: new EvidenceResolver({ driver, db: store.db, publications, logger }),
  };
  const options = {
    cohortId: 'legacy-914',
    now,
    steps: 128,
    pageSize: 64,
    batchWallMs: 60_000,
    policy: { ...CHUNK_BOUNDARY_POLICY, partitionPolicyVersion: 1 },
  };
  let result = await runNarrativeMigrationBatch(deps, options);
  for (let batch = 0; batch < 30 && !result.complete; batch += 1) {
    console.log(
      JSON.stringify({
        batch,
        phase: result.phase,
        cohort: result.cohort,
        stopped: result.stopped,
      }),
    );
    expect(
      result.stopped === undefined || result.stopped === 'batch_wall_budget',
      JSON.stringify(result),
    ).toBe(true);
    result = await runNarrativeMigrationBatch(deps, options);
  }
  expect(result.complete, JSON.stringify(result)).toBe(true);
  expect(result.cohort).toMatchObject({
    status: 'frozen',
    verified: 914,
    pinned: 0,
    unassignedSources: 0,
    unpublishedChunks: 0,
  });
  const sealed = listSessionChunks(store.db, sessionId);
  expect(sealed.length).toBe(Math.ceil(914 / CHUNK_BOUNDARY_POLICY.maxMembers));
  expect(
    sealed.every(
      (chunk) =>
        chunk.memberCount <= CHUNK_BOUNDARY_POLICY.maxMembers && chunk.publishedRevisionNo !== null,
    ),
  ).toBe(true);
  const members = sealed.flatMap((chunk) => listChunkMembers(store.db, chunk.chunkId));
  expect([...members].sort()).toEqual([...ids].sort());
  expect(new Set(members).size).toBe(914);
  expect(readFamilySelection(store.db, sessionId)?.family).toBe('chunk');
  const frozen = JSON.stringify(sealed);
  expect((await runNarrativeMigrationBatch(deps, options)).steps).toBe(0);
  expect(JSON.stringify(listSessionChunks(store.db, sessionId))).toBe(frozen);
}, 300_000);
