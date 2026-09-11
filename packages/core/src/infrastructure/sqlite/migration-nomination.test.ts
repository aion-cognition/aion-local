import { afterEach, beforeEach, expect, it } from 'vitest';

import { sealChunk } from './chunk-manifest.js';
import { SqliteStore } from './database.js';
import { freezeMigrationCohort, recordMigrationProgress } from './migration-cohorts.js';
import { recordAttemptPolicy } from './narrative-allocations.js';
import { readNarrativeMigration, beginNarrativeMigration } from './narrative-migration-job.js';
import { readMigrationIssues } from './narrative-migration-pass.js';
import { nextMigrationChunk } from './narrative-migration-read.js';
import { abandonNarrativeMigration } from './narrative-migration-state.js';
import {
  readNarrativeRevision,
  allocateNarrativeRevision,
  blockRevisionAttempt,
  CHUNK_REVISION_FAMILY,
  deferRevisionAttempt,
  publishNarrativeRevision,
} from './narrative-revisions.js';
import { captureOrderValue, touchSessionRemainder } from './source-lifecycle.js';
import { seedSource } from '../../evidence/test-support/evidence.fixture.js';
import { readSealDemand } from '../../introspection/application/seal-census.js';
import { reconsiderMigrationSession } from '../../reflection/application/migration-publication.js';

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
  touchSessionRemainder(store.db, 'session', captureOrderValue(2), NOW);
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

it.each(['no capture', 'above watermark', 'no remainder'] as const)(
  'excludes a reserved source with %s from the seal-remainder tally',
  (mode) => {
    if (mode === 'no capture') {
      store.db
        .prepare('UPDATE source_records SET capture_order_value = NULL WHERE source_id = ?')
        .run('unsealed');
    } else if (mode === 'above watermark') {
      store.db
        .prepare('UPDATE source_records SET capture_order_value = ? WHERE source_id = ?')
        .run(captureOrderValue(99), 'unsealed');
    } else {
      store.db.prepare('DELETE FROM session_remainders WHERE session_id = ?').run('session');
    }
    const demand = readSealDemand(store.db, { now: NOW, batch: 2, maxMembers: 1, maxSpanMs: 1 });
    expect(demand.blockedSourcesByReason).not.toHaveProperty('migration_reserved');
    expect(demand.blockedSourcesByReason).toHaveProperty('migration_owned', 1);
  },
);

it('does not reconsider the regrounding attempt of an already-published chunk', () => {
  const head = allocateNarrativeRevision(store.db, CHUNK_REVISION_FAMILY, chunkId, NOW);
  publishNarrativeRevision(store.db, CHUNK_REVISION_FAMILY, {
    familyKey: chunkId,
    revisionNo: head.revisionNo,
    operationId: 'published',
    evidenceRevisionJson: '{}',
    knownFrom: NOW.toISOString(),
    observedAckAt: NOW.toISOString(),
    publishedAt: NOW,
  });
  const attempt = allocateNarrativeRevision(store.db, CHUNK_REVISION_FAMILY, chunkId, NOW);
  blockRevisionAttempt(
    store.db,
    CHUNK_REVISION_FAMILY,
    chunkId,
    attempt.revisionNo,
    'member_over_resolver_budget',
  );
  recordAttemptPolicy(store.db, CHUNK_REVISION_FAMILY, chunkId, attempt.revisionNo, {
    renderedInputAllowance: 1,
  });
  reconsiderMigrationSession(store.db, readNarrativeMigration(store.db, 'cohort')!, 'session');
  expect(
    readNarrativeRevision(store.db, CHUNK_REVISION_FAMILY, chunkId, attempt.revisionNo)
      ?.blockedReason,
  ).toBe('member_over_resolver_budget');
});

it('names the attempt scan bound independently of the number of chunks', () => {
  for (let index = 0; index < 129; index += 1) {
    const row = allocateNarrativeRevision(store.db, CHUNK_REVISION_FAMILY, chunkId, NOW);
    blockRevisionAttempt(
      store.db,
      CHUNK_REVISION_FAMILY,
      chunkId,
      row.revisionNo,
      'member_over_resolver_budget',
    );
  }
  reconsiderMigrationSession(store.db, readNarrativeMigration(store.db, 'cohort')!, 'session');
  expect(store.db.prepare('SELECT COUNT(*) AS n FROM chunks').get()).toEqual({ n: 1 });
  expect(readMigrationIssues(store.db, 'cohort').issues).toContainEqual({
    id: 'session',
    reason: 'blocked_attempt_scan_bound',
  });
});
