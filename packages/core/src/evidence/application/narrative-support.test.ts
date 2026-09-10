import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { certifyNarrativeSupport } from './narrative-support.js';
import { certifyNodeSupport } from './node-support.js';
import { sealChunk } from '../../infrastructure/sqlite/chunk-manifest.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { recordRevisionCitations } from '../../infrastructure/sqlite/narrative-citations.js';
import {
  allocateNarrativeRevision,
  CHUNK_REVISION_FAMILY,
  OVERVIEW_REVISION_FAMILY,
  publishNarrativeRevision,
} from '../../infrastructure/sqlite/narrative-revisions.js';
import { recordSourceRecord } from '../../infrastructure/sqlite/source-identity.js';
import { establishNodeSupportScopes } from '../test-support/evidence.fixture.js';

/**
 * What holds a narrative up, asked of the records.
 *
 * The distinction every case here turns on: an id the manifest binds and can account for, an id
 * it binds and cannot, and an id it was never asked about. Only the first is a licence, and the
 * third is silence — a census that was never taken proves nothing about what is there.
 */

const NOW = new Date('2026-09-09T12:00:00.000Z');
const SESSION = 'session-a';

let store: SqliteStore;

function accept(sourceId: string): void {
  recordSourceRecord(store.db, {
    sourceId,
    sessionId: SESSION,
    verificationStatus: 'verified',
    archive: {
      canonicalArchiveId: `archive-${sourceId}`,
      archiveSchemaVersion: 1,
      identityHash: `identity-${sourceId}`,
      verifiedContentDigest: `digest-${sourceId}`,
      verificationPolicyVersion: 1,
      archivedAt: NOW.toISOString(),
    },
    occurredAt: NOW.toISOString(),
    createdAt: NOW,
  });
}

function publishChunk(sourceIds: readonly string[]): string {
  for (const sourceId of sourceIds) {
    accept(sourceId);
  }
  const { chunkId } = sealChunk(store.db, { sessionId: SESSION, sourceIds, sealedAt: NOW });
  const allocation = allocateNarrativeRevision(store.db, CHUNK_REVISION_FAMILY, chunkId, NOW);
  publishNarrativeRevision(store.db, CHUNK_REVISION_FAMILY, {
    familyKey: chunkId,
    revisionNo: allocation.revisionNo,
    operationId: `op-${chunkId}`,
    evidenceRevisionJson: '{"dependencies":[]}',
    knownFrom: NOW.toISOString(),
    observedAckAt: NOW.toISOString(),
    publishedAt: NOW,
  });
  return allocation.nodeId;
}

function publishOverview(familyKey: string): string {
  const allocation = allocateNarrativeRevision(store.db, OVERVIEW_REVISION_FAMILY, familyKey, NOW);
  publishNarrativeRevision(store.db, OVERVIEW_REVISION_FAMILY, {
    familyKey,
    revisionNo: allocation.revisionNo,
    operationId: `op-${familyKey}`,
    evidenceRevisionJson: '{"dependencies":[]}',
    knownFrom: NOW.toISOString(),
    observedAckAt: NOW.toISOString(),
    publishedAt: NOW,
  });
  return allocation.nodeId;
}

beforeEach(() => {
  store = new SqliteStore({ filePath: ':memory:' });
});

afterEach(() => {
  store.close();
});

describe('what the manifest says about a narrative', () => {
  it('says nothing about an id it never bound', () => {
    const reading = certifyNarrativeSupport(store.db, 'a-legacy-narrative');
    expect(reading.support).toBe('unbound');
    expect(reading.members).toBe(0);
  });

  it('holds a chunk revision up on its frozen membership', () => {
    const nodeId = publishChunk(['s1', 's2']);
    const reading = certifyNarrativeSupport(store.db, nodeId);
    expect(reading.support).toBe('supported');
    expect(reading.members).toBe(2);
  });

  it('holds an overview up on what it cited', () => {
    const nodeId = publishOverview('day:2026-09-09');
    recordRevisionCitations(store.db, nodeId, [{ targetId: 'chunk-1', targetKind: 'source' }]);
    const reading = certifyNarrativeSupport(store.db, nodeId);
    expect(reading.support).toBe('supported');
    expect(reading.citations).toBe(1);
  });

  /** Bound and unaccountable is a third answer, and it authorizes nothing either. */
  it('answers unknown for a bound revision carrying neither members nor citations', () => {
    const nodeId = publishOverview('day:2026-09-10');
    expect(certifyNarrativeSupport(store.db, nodeId).support).toBe('unknown');
  });
});

describe('the general support predicate over a narrative node', () => {
  /**
   * The suppression hazard this closes. A chunk's narrative is produced by no source and named by
   * no statement, so every source-side census over it is established and empty by construction —
   * and the reading that stopped there called the only record of an evicted session unsupported.
   */
  it('calls a published chunk revision supported where every source census is established and empty', () => {
    const nodeId = publishChunk(['s1']);
    // Established explicitly: an absent census is not a clean one, and this case is about what
    // happens once every one of them has actually been counted and come back empty.
    establishNodeSupportScopes(store.db, nodeId, NOW);

    const reading = certifyNodeSupport(store.db, nodeId);
    expect(reading.support).toBe('supported');
    expect(reading.reason).toContain('published narrative revision');
  });

  it('still calls an unrelated node with every census established and empty unsupported', () => {
    establishNodeSupportScopes(store.db, 'some-claim', NOW);
    expect(certifyNodeSupport(store.db, 'some-claim').support).toBe('unsupported');
  });
});
