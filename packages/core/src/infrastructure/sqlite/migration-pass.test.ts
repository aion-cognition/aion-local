import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { sealChunk } from './chunk-manifest.js';
import { SqliteStore } from './database.js';
import { freezeMigrationCohort, recordMigrationProgress } from './migration-cohorts.js';
import { rememberMigrationOrder } from './migration-partition.js';
import {
  advanceNarrativeMigration,
  beginNarrativeMigration,
  readNarrativeMigration,
} from './narrative-migration-job.js';
import {
  beginMigrationPass,
  finishMigrationPass,
  readMigrationIssues,
  holdRepeatedCensusRefusal,
  recordMigrationRetryFailure,
} from './narrative-migration-pass.js';
import { adoptExistingMigrationChunk } from './narrative-migration-read.js';
import { refreshNarrativeMigration } from './narrative-migration-state.js';
import {
  allocateNarrativeRevision,
  CHUNK_REVISION_FAMILY,
  deferRevisionAttempt,
  blockRevisionAttempt,
  publishNarrativeRevision,
} from './narrative-revisions.js';
import { seedSource } from '../../evidence/test-support/evidence.fixture.js';

const NOW = new Date('2026-09-10T10:00:00Z');
const policy = {
  maxMembers: 24,
  maxSpanMs: 86400000,
  renderedInputAllowance: 16384,
  partitionPolicyVersion: 1,
};
let store: SqliteStore;
let directory: string;
let path: string;
let chunkId: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'aion-migration-pass-'));
  path = join(directory, 'store.sqlite');
  store = new SqliteStore({ filePath: path });
  seedSource(store.db, {
    sourceId: 'source',
    sessionId: 'session',
    identity: 'source',
    content: { observations: ['content'] },
    now: NOW,
  });
  ({ chunkId } = sealChunk(store.db, {
    sessionId: 'session',
    sourceIds: ['source'],
    sealedAt: NOW,
  }));
  freezeMigrationCohort(store.db, {
    cohortId: 'cohort',
    cohortDigest: 'fixed',
    intakeWatermark: 1,
    archiveRowidLow: 1,
    archiveRowidHigh: 1,
    graphCensusDigest: 'fixed',
    orderingPolicyVersion: 1,
    createdAt: NOW,
    members: ['source'],
  });
  recordMigrationProgress(store.db, {
    cohortId: 'cohort',
    sourceId: 'source',
    status: 'pinned',
    reason: 'raw proof missing',
  });
  const initial = beginNarrativeMigration(store.db, { cohortId: 'cohort', policy, now: NOW });
  advanceNarrativeMigration(store.db, initial, 'partition', '', NOW);
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

it('preserves a blocked pass and one issue across reopen until explicit refresh', () => {
  for (let pass = 0; pass < 2; pass += 1) {
    const job = readNarrativeMigration(store.db, 'cohort')!;
    beginMigrationPass(store.db, job);
    finishMigrationPass(store.db, job, false, NOW);
  }
  expect(readNarrativeMigration(store.db, 'cohort')?.state).toBe('blocked');
  store.close();
  store = new SqliteStore({ filePath: path });
  const blocked = readNarrativeMigration(store.db, 'cohort')!;
  expect(blocked.state).toBe('blocked');
  expect(readMigrationIssues(store.db, 'cohort')).toEqual({
    issues: [{ id: 'source', reason: 'raw proof missing' }],
    issuesTruncated: false,
  });
  expect(advanceNarrativeMigration(store.db, blocked, 'complete', '', NOW)).toBe(false);
  expect(refreshNarrativeMigration(store.db, blocked, NOW)).toBe(true);
  expect(readNarrativeMigration(store.db, 'cohort')).toMatchObject({
    state: 'running',
    phase: 'verify',
  });
  expect(store.db.prepare('SELECT COUNT(*) AS n FROM narrative_migration_issues').get()).toEqual({
    n: 1,
  });
  expect(readMigrationIssues(store.db, 'cohort').issues).toEqual([]);
});

it('keeps timed initial-publication retries running instead of declaring an unchanged block', () => {
  recordMigrationProgress(store.db, {
    cohortId: 'cohort',
    sourceId: 'source',
    status: 'verified',
    partitionAssignment: chunkId,
  });
  const attempt = allocateNarrativeRevision(store.db, CHUNK_REVISION_FAMILY, chunkId, NOW);
  deferRevisionAttempt(
    store.db,
    CHUNK_REVISION_FAMILY,
    chunkId,
    attempt.revisionNo,
    new Date(NOW.getTime() + 60000),
  );
  const job = readNarrativeMigration(store.db, 'cohort')!;
  beginMigrationPass(store.db, job);
  expect(finishMigrationPass(store.db, job, false, NOW)).toBe('publication_retry_wait');
  expect(readNarrativeMigration(store.db, 'cohort')).toMatchObject({
    state: 'running',
    phase: 'publish',
  });
});

it('names a pin that prevents census after the full verification sweep', () => {
  const initial = readNarrativeMigration(store.db, 'cohort')!;
  advanceNarrativeMigration(store.db, initial, 'census', '', NOW);
  const census = readNarrativeMigration(store.db, 'cohort')!;
  holdRepeatedCensusRefusal(store.db, census, NOW);
  expect(readNarrativeMigration(store.db, 'cohort')?.state).toBe('running');
  holdRepeatedCensusRefusal(store.db, census, NOW);
  expect(readNarrativeMigration(store.db, 'cohort')).toMatchObject({
    state: 'blocked',
    blockedReason: 'cohort_not_fully_accounted',
  });
  expect(readMigrationIssues(store.db, 'cohort').issues).toEqual([
    { id: 'source', reason: 'raw proof missing' },
  ]);
});

it('retains separate reasons from multiple blocked revisions of the same chunk', () => {
  recordMigrationProgress(store.db, {
    cohortId: 'cohort',
    sourceId: 'source',
    status: 'verified',
    partitionAssignment: chunkId,
  });
  for (const reason of ['member_scope_census_missing', 'member_evidence_missing']) {
    const row = allocateNarrativeRevision(store.db, CHUNK_REVISION_FAMILY, chunkId, NOW);
    blockRevisionAttempt(store.db, CHUNK_REVISION_FAMILY, chunkId, row.revisionNo, reason);
  }
  for (let pass = 0; pass < 2; pass += 1) {
    const job = readNarrativeMigration(store.db, 'cohort')!;
    beginMigrationPass(store.db, job);
    finishMigrationPass(store.db, job, false, NOW);
  }
  expect(readNarrativeMigration(store.db, 'cohort')?.state).toBe('blocked');
  expect(readMigrationIssues(store.db, 'cohort').issues).toEqual(
    expect.arrayContaining([
      { id: chunkId, reason: 'member_scope_census_missing' },
      { id: chunkId, reason: 'member_evidence_missing' },
    ]),
  );
});

it('ignores a published chunk regrounding block when comparing migration holds', () => {
  recordMigrationProgress(store.db, {
    cohortId: 'cohort',
    sourceId: 'source',
    status: 'verified',
  });
  store.db
    .transaction(() => {
      rememberMigrationOrder(store.db, {
        cohortId: 'cohort',
        sourceId: 'source',
        value: NOW.toISOString(),
        basis: 'graph_tx_from',
      });
    })
    .immediate();
  expect(adoptExistingMigrationChunk(store.db, 'cohort', 'source').status).toBe('adopted');
  const head = allocateNarrativeRevision(store.db, CHUNK_REVISION_FAMILY, chunkId, NOW);
  publishNarrativeRevision(store.db, CHUNK_REVISION_FAMILY, {
    familyKey: chunkId,
    revisionNo: head.revisionNo,
    operationId: 'published-head',
    evidenceRevisionJson: '{}',
    knownFrom: NOW.toISOString(),
    observedAckAt: NOW.toISOString(),
    publishedAt: NOW,
  });
  recordMigrationProgress(store.db, {
    cohortId: 'cohort',
    sourceId: 'source',
    status: 'pinned',
    reason: 'raw proof missing',
    partitionAssignment: chunkId,
  });
  const revision = allocateNarrativeRevision(store.db, CHUNK_REVISION_FAMILY, chunkId, NOW);
  for (const reason of ['member_scope_census_missing', 'member_evidence_missing']) {
    blockRevisionAttempt(store.db, CHUNK_REVISION_FAMILY, chunkId, revision.revisionNo, reason);
    const job = readNarrativeMigration(store.db, 'cohort')!;
    beginMigrationPass(store.db, job);
    finishMigrationPass(store.db, job, false, NOW);
  }
  expect(readNarrativeMigration(store.db, 'cohort')?.state).toBe('blocked');
  expect(readMigrationIssues(store.db, 'cohort').issues).toEqual([
    { id: 'source', reason: 'raw proof missing' },
  ]);
});

it('retrofits retry accounting without inventing prior attempt counts', () => {
  store.db.exec(
    'ALTER TABLE narrative_migration_issues RENAME COLUMN retry_failures TO old_retry_failures',
  );
  store.close();
  store = new SqliteStore({ filePath: path });
  const job = readNarrativeMigration(store.db, 'cohort')!;
  expect(recordMigrationRetryFailure(store.db, job, chunkId, 'first_failure')).toBe(1);
  expect(recordMigrationRetryFailure(store.db, job, chunkId, 'different_failure')).toBe(2);
});
