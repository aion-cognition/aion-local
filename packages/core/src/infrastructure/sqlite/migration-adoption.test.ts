import { afterEach, beforeEach, expect, it } from 'vitest';

import { sealChunk } from './chunk-manifest.js';
import { SqliteStore } from './database.js';
import {
  freezeMigrationCohort,
  recordMigrationProgress,
  readMigrationProgress,
} from './migration-cohorts.js';
import { rememberMigrationPolicy, rememberMigrationOrder } from './migration-partition.js';
import { adoptExistingMigrationChunk } from './narrative-migration-read.js';
import { seedSource } from '../../evidence/test-support/evidence.fixture.js';

const NOW = new Date('2026-09-10T10:00:00.000Z');
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
  for (const sourceId of ['a', 'b']) {
    seedSource(store.db, {
      sourceId,
      sessionId: 'session',
      identity: sourceId,
      content: { observations: [sourceId] },
      now: NOW,
    });
  }
  ({ chunkId } = sealChunk(store.db, {
    sessionId: 'session',
    sourceIds: ['a', 'b'],
    sealedAt: NOW,
  }));
  freezeMigrationCohort(store.db, {
    cohortId: 'cohort',
    cohortDigest: 'fixture',
    intakeWatermark: 2,
    archiveRowidLow: 1,
    archiveRowidHigh: 2,
    graphCensusDigest: 'fixture',
    orderingPolicyVersion: 1,
    createdAt: NOW,
    members: ['a', 'b'],
  });
  rememberMigrationPolicy(store.db, 'cohort', policy);
  for (const sourceId of ['a', 'b']) {
    recordMigrationProgress(store.db, { cohortId: 'cohort', sourceId, status: 'verified' });
    store.db
      .transaction(() => {
        rememberMigrationOrder(store.db, {
          cohortId: 'cohort',
          sourceId,
          value: NOW.toISOString(),
          basis: 'graph_tx_from',
        });
      })
      .immediate();
  }
});
afterEach(() => {
  store.close();
});

it.each(['pinned', 'gapped'] as const)(
  'reports a %s member without assigning part of its pre-existing chunk',
  (problem) => {
    if (problem === 'pinned') {
      recordMigrationProgress(store.db, {
        cohortId: 'cohort',
        sourceId: 'b',
        status: 'pinned',
        reason: 'proof withdrawn',
      });
    } else {
      store.db
        .prepare(
          "UPDATE migration_progress SET partition_gap = 'capture clock unproved' WHERE source_id = 'b'",
        )
        .run();
    }
    expect(adoptExistingMigrationChunk(store.db, 'cohort', 'a')).toMatchObject({
      status: 'refused',
    });
    expect(readMigrationProgress(store.db, 'cohort', 'a')?.partitionAssignment).toBeNull();
    expect(readMigrationProgress(store.db, 'cohort', 'b')?.partitionAssignment).toBeNull();
  },
);

it('adopts the whole verified membership once without changing its chunk identity', () => {
  adoptExistingMigrationChunk(store.db, 'cohort', 'a');
  for (const sourceId of ['a', 'b']) {
    expect(readMigrationProgress(store.db, 'cohort', sourceId)?.partitionAssignment).toBe(chunkId);
  }
});
