import { afterEach, beforeEach, expect, it } from 'vitest';

import { certifyNarrativeSupport } from './narrative-support.js';
import { sealChunk } from '../../infrastructure/sqlite/chunk-manifest.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import {
  allocateNarrativeRevision,
  CHUNK_REVISION_FAMILY,
  prepareNarrativeRevision,
  publishNarrativeRevision,
} from '../../infrastructure/sqlite/narrative-revisions.js';
import { recordSourceRecord } from '../../infrastructure/sqlite/source-identity.js';

const NOW = new Date('2026-09-09T12:00:00Z');
let store: SqliteStore;
let chunkId: string;
beforeEach(() => {
  store = new SqliteStore({ filePath: ':memory:' });
  recordSourceRecord(store.db, {
    sourceId: 'source',
    sessionId: 'session',
    verificationStatus: 'verified',
    occurredAt: NOW.toISOString(),
    createdAt: NOW,
    archive: {
      canonicalArchiveId: 'archive',
      archiveSchemaVersion: 1,
      identityHash: 'identity',
      verifiedContentDigest: 'digest',
      verificationPolicyVersion: 1,
      archivedAt: NOW.toISOString(),
    },
  });
  ({ chunkId } = sealChunk(store.db, {
    sessionId: 'session',
    sourceIds: ['source'],
    sealedAt: NOW,
  }));
});
afterEach(() => {
  store.close();
});

it.each(['allocated', 'prepared'] as const)(
  'does not certify %s output from membership alone',
  (state) => {
    const revision = allocateNarrativeRevision(store.db, CHUNK_REVISION_FAMILY, chunkId, NOW);
    if (state === 'prepared') {
      prepareNarrativeRevision(
        store.db,
        CHUNK_REVISION_FAMILY,
        chunkId,
        revision.revisionNo,
        'pending-operation',
      );
    }
    expect(certifyNarrativeSupport(store.db, revision.nodeId).support).not.toBe('supported');
  },
);

it('control: an acknowledged revision can use its durable members', () => {
  const revision = allocateNarrativeRevision(store.db, CHUNK_REVISION_FAMILY, chunkId, NOW);
  publishNarrativeRevision(store.db, CHUNK_REVISION_FAMILY, {
    familyKey: chunkId,
    revisionNo: revision.revisionNo,
    operationId: 'published-operation',
    evidenceRevisionJson: '{"dependencies":[]}',
    knownFrom: NOW.toISOString(),
    observedAckAt: NOW.toISOString(),
    publishedAt: NOW,
  });
  expect(certifyNarrativeSupport(store.db, revision.nodeId).support).toBe('supported');
});
