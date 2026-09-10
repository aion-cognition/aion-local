import { afterEach, beforeEach, expect, it } from 'vitest';

import { listChunkMembers, readChunk, sealChunk } from './chunk-manifest.js';
import { SqliteStore } from './database.js';
import { recordSourceRecord } from './source-identity.js';

let store: SqliteStore;
const NOW = new Date('2026-09-09T00:00:00Z');
function source(id: string, hour: number): void {
  const occurredAt = new Date(Date.UTC(2026, 8, 1, hour)).toISOString();
  recordSourceRecord(store.db, {
    sourceId: id,
    sessionId: 'session',
    verificationStatus: 'verified',
    occurredAt,
    createdAt: NOW,
    archive: {
      canonicalArchiveId: `archive-${id}`,
      archiveSchemaVersion: 1,
      identityHash: id,
      verifiedContentDigest: id,
      verificationPolicyVersion: 1,
      archivedAt: NOW.toISOString(),
    },
  });
}
beforeEach(() => {
  store = new SqliteStore({ filePath: ':memory:' });
});
afterEach(() => {
  store.close();
});

it('records a later members overlap even when the earliest member lies before the old span', () => {
  source('old-start', 10);
  source('old-end', 20);
  const old = sealChunk(store.db, {
    sessionId: 'session',
    sourceIds: ['old-start', 'old-end'],
    sealedAt: NOW,
  });
  source('new-earliest', 5);
  source('new-overlapping', 15);
  const later = sealChunk(store.db, {
    sessionId: 'session',
    sourceIds: ['new-earliest', 'new-overlapping'],
    sealedAt: NOW,
  });
  expect(later.chunkId).not.toBe(old.chunkId);
  expect(listChunkMembers(store.db, old.chunkId)).toEqual(['old-start', 'old-end']);
  expect(readChunk(store.db, later.chunkId)?.overlaps).toContain(old.chunkId);
});

it('control: a membership outside the old span records no overlap', () => {
  source('old-start', 10);
  source('old-end', 20);
  sealChunk(store.db, { sessionId: 'session', sourceIds: ['old-start', 'old-end'], sealedAt: NOW });
  source('new-outside', 21);
  const later = sealChunk(store.db, {
    sessionId: 'session',
    sourceIds: ['new-outside'],
    sealedAt: NOW,
  });
  expect(readChunk(store.db, later.chunkId)?.overlaps).toEqual([]);
});
