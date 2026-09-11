import { expect, it, vi } from 'vitest';

import { sealChunk } from './chunk-manifest.js';
import { SqliteStore } from './database.js';
import { freezeMigrationCohort, recordMigrationProgress } from './migration-cohorts.js';
import { rememberMigrationOrder } from './migration-partition.js';
import {
  beginNarrativeMigration,
  advanceNarrativeMigration,
  readNarrativeMigration,
} from './narrative-migration-job.js';
import * as pass from './narrative-migration-pass.js';
import { readMigrationIssues } from './narrative-migration-pass.js';
import { adoptExistingMigrationChunk } from './narrative-migration-read.js';
import {
  allocateNarrativeRevision,
  blockRevisionAttempt,
  recordRevisionAttemptFailure,
  publishNarrativeRevision,
  CHUNK_REVISION_FAMILY,
} from './narrative-revisions.js';
import { seedSource } from '../../evidence/test-support/evidence.fixture.js';
import { scheduleMigrationPublicationRetry } from '../../reflection/application/migration-publication.js';

it.each(['none', 'before-accounting', 'before-hold'] as const)(
  'retains current blocker diagnostics and checks a concurrent publication (%s)',
  (race) => {
    const store = new SqliteStore({ filePath: ':memory:' });
    const now = new Date('2026-09-11T00:00:00Z');
    const ids = ['a', 'b'];
    const chunks = new Map<string, string>();
    try {
      for (const id of ids) {
        seedSource(store.db, {
          sourceId: id,
          sessionId: id,
          identity: id,
          content: { observations: [id] },
          now,
        });
        chunks.set(
          id,
          sealChunk(store.db, { sessionId: id, sourceIds: [id], sealedAt: now }).chunkId,
        );
      }
      freezeMigrationCohort(store.db, {
        cohortId: 'budget',
        cohortDigest: 'fixed',
        intakeWatermark: 2,
        archiveRowidLow: 1,
        archiveRowidHigh: 2,
        graphCensusDigest: 'fixed',
        orderingPolicyVersion: 1,
        createdAt: now,
        members: ids,
      });
      const initial = beginNarrativeMigration(store.db, {
        cohortId: 'budget',
        policy: {
          maxMembers: 24,
          maxSpanMs: 86400000,
          renderedInputAllowance: 16384,
          partitionPolicyVersion: 1,
        },
        now,
      });
      for (const id of ids) {
        recordMigrationProgress(store.db, { cohortId: 'budget', sourceId: id, status: 'verified' });
        store.db
          .transaction(() => {
            rememberMigrationOrder(store.db, {
              cohortId: 'budget',
              sourceId: id,
              value: now.toISOString(),
              basis: 'graph_tx_from',
            });
          })
          .immediate();
        expect(adoptExistingMigrationChunk(store.db, 'budget', id).status).toBe('adopted');
      }
      advanceNarrativeMigration(store.db, initial, 'publish', '', now);
      const failed = allocateNarrativeRevision(
        store.db,
        CHUNK_REVISION_FAMILY,
        chunks.get('a')!,
        now,
      );
      const blocked = allocateNarrativeRevision(
        store.db,
        CHUNK_REVISION_FAMILY,
        chunks.get('b')!,
        now,
      );
      blockRevisionAttempt(
        store.db,
        CHUNK_REVISION_FAMILY,
        chunks.get('b')!,
        blocked.revisionNo,
        'member_scope_census_missing',
      );
      function publishPeer(): void {
        const row = allocateNarrativeRevision(
          store.db,
          CHUNK_REVISION_FAMILY,
          chunks.get('a')!,
          now,
        );
        publishNarrativeRevision(store.db, CHUNK_REVISION_FAMILY, {
          familyKey: chunks.get('a')!,
          revisionNo: row.revisionNo,
          operationId: 'peer',
          evidenceRevisionJson: '{}',
          knownFrom: now.toISOString(),
          observedAckAt: now.toISOString(),
          publishedAt: now,
        });
      }
      const original = pass.recordMigrationRetryFailure;
      vi.spyOn(pass, 'recordMigrationRetryFailure').mockImplementation((...args) => {
        const count = original(...args);
        if (race === 'before-hold' && count === 3) {
          publishPeer();
        }
        return count;
      });
      for (let attempt = 0; attempt < 3; attempt += 1) {
        recordRevisionAttemptFailure(store.db, CHUNK_REVISION_FAMILY, {
          familyKey: chunks.get('a')!,
          revisionNo: failed.revisionNo,
          reason: 'synthesis_failed',
        });
        if (race === 'before-accounting' && attempt === 2) {
          publishPeer();
        }
        scheduleMigrationPublicationRetry(
          store.db,
          readNarrativeMigration(store.db, 'budget')!,
          {
            status: 'failed',
            chunkId: chunks.get('a')!,
            revisionNo: failed.revisionNo,
            reason: 'synthesis_failed',
          },
          now,
        );
      }
      expect(readNarrativeMigration(store.db, 'budget')?.state).toBe(
        race === 'none' ? 'blocked' : 'running',
      );
      if (race !== 'none') {
        return;
      }
      expect(readMigrationIssues(store.db, 'budget').issues).toContainEqual({
        id: chunks.get('b'),
        reason: 'member_scope_census_missing',
      });
    } finally {
      vi.restoreAllMocks();
      store.close();
    }
  },
);
