import { afterEach, beforeEach, expect, it } from 'vitest';

import { sealChunk } from './chunk-manifest.js';
import { SqliteStore } from './database.js';
import { freezeMigrationCohort, recordMigrationProgress } from './migration-cohorts.js';
import { beginNarrativeMigration } from './narrative-migration-job.js';
import { nextMigrationChunk } from './narrative-migration-read.js';
import { abandonNarrativeMigration } from './narrative-migration-state.js';
import {
  allocateNarrativeRevision,
  blockRevisionAttempt,
  CHUNK_REVISION_FAMILY,
  deferRevisionAttempt,
  publishNarrativeRevision,
} from './narrative-revisions.js';
import { seedSource } from '../../evidence/test-support/evidence.fixture.js';
import { readSealDemand } from '../../introspection/application/seal-census.js';

const NOW = new Date('2026-09-10T10:00:00Z');
const policy = {
  maxMembers: 24,
  maxSpanMs: 86400000,
  renderedInputAllowance: 16384,
  partitionPolicyVersion: 1,
};
let store: SqliteStore;
let chunkId: string;
beforeEach(() => {
  store = new SqliteStore({ filePath: ':memory:' });
  for (const id of ['sealed', 'unsealed']) {
    seedSource(store.db, {
      sourceId: id,
      sessionId: 'session',
      identity: id,
      content: { observations: [id] },
      now: NOW,
    });
  }
  ({ chunkId } = sealChunk(store.db, {
    sessionId: 'session',
    sourceIds: ['sealed'],
    sealedAt: NOW,
  }));
  freezeMigrationCohort(store.db, {
    cohortId: 'cohort',
    cohortDigest: 'fixed',
    intakeWatermark: 2,
    archiveRowidLow: 1,
    archiveRowidHigh: 2,
    graphCensusDigest: 'fixed',
    orderingPolicyVersion: 1,
    createdAt: NOW,
    members: ['sealed', 'unsealed'],
  });
  beginNarrativeMigration(store.db, { cohortId: 'cohort', policy, now: NOW });
  recordMigrationProgress(store.db, {
    cohortId: 'cohort',
    sourceId: 'sealed',
    status: 'verified',
    partitionAssignment: chunkId,
  });
});
afterEach(() => {
  store.close();
});

it('keeps reserved sources and owned membership visible on the held side', () => {
  const input = { now: NOW, batch: 2, maxMembers: 1, maxSpanMs: 1 };
  const held = readSealDemand(store.db, input);
  expect(held.dueChunks).toBe(0);
  expect(held.blockedSourcesByReason).toMatchObject({ migration_reserved: 1, migration_owned: 1 });
  abandonNarrativeMigration(store.db, 'cohort', NOW);
  const released = readSealDemand(store.db, input);
  expect(released.dueChunks).toBe(1);
  expect(released.blockedSourcesByReason).not.toHaveProperty('migration_owned');
  expect(released.blockedSourcesByReason).not.toHaveProperty('migration_reserved');
});

it('only nominates an initial publication when its recorded attempt is due', () => {
  expect(nextMigrationChunk(store.db, 'cohort', '', NOW)).toBe(chunkId);
  const attempt = allocateNarrativeRevision(store.db, CHUNK_REVISION_FAMILY, chunkId, NOW);
  const later = new Date(NOW.getTime() + 60000);
  deferRevisionAttempt(store.db, CHUNK_REVISION_FAMILY, chunkId, attempt.revisionNo, later);
  expect(nextMigrationChunk(store.db, 'cohort', '', NOW)).toBeUndefined();
  expect(nextMigrationChunk(store.db, 'cohort', '', later)).toBe(chunkId);
  blockRevisionAttempt(
    store.db,
    CHUNK_REVISION_FAMILY,
    chunkId,
    attempt.revisionNo,
    'evidence_unavailable',
  );
  expect(nextMigrationChunk(store.db, 'cohort', '', later)).toBeUndefined();
});

it('leaves a published head to the regrounding scheduler even if its evidence is stale', () => {
  const attempt = allocateNarrativeRevision(store.db, CHUNK_REVISION_FAMILY, chunkId, NOW);
  publishNarrativeRevision(store.db, CHUNK_REVISION_FAMILY, {
    familyKey: chunkId,
    revisionNo: attempt.revisionNo,
    operationId: 'fixture-publication',
    evidenceRevisionJson: '{}',
    knownFrom: NOW.toISOString(),
    observedAckAt: NOW.toISOString(),
    publishedAt: NOW,
  });
  expect(nextMigrationChunk(store.db, 'cohort', '', NOW)).toBeUndefined();
});
