import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  chunkIdentity,
  chunkOfSource,
  listChunkMembers,
  listSessionChunks,
  markChunkPublished,
  readChunk,
  readRemainderMembers,
  recordRevisionCitations,
  recordRevisionDependencies,
  revisionsDependingOn,
  sealChunk,
  unorderedSessionSources,
} from './chunk-manifest.js';
import { SqliteStore } from './database.js';
import { readCitationsFrom, readCitationsOf } from './narrative-citations.js';
import { recordSourceRecord } from './source-identity.js';
import { captureOrderValue, touchSessionRemainder } from './source-lifecycle.js';
import { buildEvidenceRevision } from '../publication/preconditions.js';

const NOW = new Date('2026-09-09T09:00:00.000Z');
const SESSION = 'session-a';

const ARCHIVE_PROOF = {
  canonicalArchiveId: 'archive-1',
  archiveSchemaVersion: 1,
  identityHash: 'identity-1',
  verifiedContentDigest: 'digest-1',
  verificationPolicyVersion: 1,
  archivedAt: NOW.toISOString(),
};

let store: SqliteStore;

function accept(sourceId: string, position: number, sessionId = SESSION): void {
  recordSourceRecord(store.db, {
    sourceId,
    sessionId,
    verificationStatus: 'verified',
    occurredAt: NOW.toISOString(),
    createdAt: NOW,
    archive: { ...ARCHIVE_PROOF, canonicalArchiveId: `archive-${sourceId}` },
    captureOrderValue: captureOrderValue(position),
    captureOrderBasis: 'archive_acceptance',
  });
  touchSessionRemainder(store.db, sessionId, captureOrderValue(position), NOW);
}

beforeEach(() => {
  store = new SqliteStore({ filePath: ':memory:' });
});

afterEach(() => {
  store.close();
});

describe('chunk identity', () => {
  it('is the membership, so the read order cannot change it', () => {
    expect(chunkIdentity(SESSION, ['b', 'a'])).toBe(chunkIdentity(SESSION, ['a', 'b']));
    expect(chunkIdentity(SESSION, ['a', 'a', 'b'])).toBe(chunkIdentity(SESSION, ['a', 'b']));
  });

  it('separates a different session, a different set and a different partition policy', () => {
    const base = chunkIdentity(SESSION, ['a', 'b'], 1);
    expect(chunkIdentity('session-b', ['a', 'b'], 1)).not.toBe(base);
    expect(chunkIdentity(SESSION, ['a', 'c'], 1)).not.toBe(base);
    expect(chunkIdentity(SESSION, ['a', 'b'], 2)).not.toBe(base);
  });
});

describe('sealing', () => {
  it('freezes membership with its ordinals and is a no-op on a repeat', () => {
    accept('s1', 1);
    accept('s2', 2);
    const first = sealChunk(store.db, {
      sessionId: SESSION,
      sourceIds: ['s1', 's2'],
      sealedAt: NOW,
    });
    expect(first.created).toBe(true);
    expect(listChunkMembers(store.db, first.chunkId)).toEqual(['s1', 's2']);
    expect(readChunk(store.db, first.chunkId)?.memberCount).toBe(2);
    expect(readChunk(store.db, first.chunkId)?.state).toBe('sealed');

    const again = sealChunk(store.db, {
      sessionId: SESSION,
      sourceIds: ['s1', 's2'],
      sealedAt: new Date(NOW.getTime() + 1000),
    });
    expect(again).toEqual({ chunkId: first.chunkId, created: false });
    expect(listSessionChunks(store.db, SESSION)).toHaveLength(1);
  });

  it('refuses to seal a source that already belongs to another chunk, and writes nothing', () => {
    accept('s1', 1);
    accept('s2', 2);
    const first = sealChunk(store.db, { sessionId: SESSION, sourceIds: ['s1'], sealedAt: NOW });
    expect(() =>
      sealChunk(store.db, { sessionId: SESSION, sourceIds: ['s1', 's2'], sealedAt: NOW }),
    ).toThrow();
    expect(listSessionChunks(store.db, SESSION).map((chunk) => chunk.chunkId)).toEqual([
      first.chunkId,
    ]);
    expect(chunkOfSource(store.db, 's2')).toBeUndefined();
  });

  it('moves the chunk state when its first revision publishes', () => {
    accept('s1', 1);
    const { chunkId } = sealChunk(store.db, {
      sessionId: SESSION,
      sourceIds: ['s1'],
      sealedAt: NOW,
    });
    markChunkPublished(store.db, chunkId);
    expect(readChunk(store.db, chunkId)?.state).toBe('published');
  });
});

describe('the remainder', () => {
  it('holds the session sources no chunk has taken, in capture order', () => {
    accept('s2', 2);
    accept('s1', 1);
    accept('s3', 3);
    expect(readRemainderMembers(store.db, SESSION, 10).map((row) => row.sourceId)).toEqual([
      's1',
      's2',
      's3',
    ]);

    sealChunk(store.db, { sessionId: SESSION, sourceIds: ['s1', 's2'], sealedAt: NOW });
    expect(readRemainderMembers(store.db, SESSION, 10).map((row) => row.sourceId)).toEqual(['s3']);
  });

  it('stops at the watermark, so an unacknowledged acceptance is not sealed', () => {
    accept('s1', 1);
    // Recorded but never acknowledged: the source row exists and the watermark never moved to it.
    recordSourceRecord(store.db, {
      sourceId: 's2',
      sessionId: SESSION,
      verificationStatus: 'verified',
      occurredAt: NOW.toISOString(),
      createdAt: NOW,
      archive: { ...ARCHIVE_PROOF, canonicalArchiveId: 'archive-s2' },
      captureOrderValue: captureOrderValue(2),
      captureOrderBasis: 'archive_acceptance',
    });
    expect(readRemainderMembers(store.db, SESSION, 10).map((row) => row.sourceId)).toEqual(['s1']);
  });

  it('leaves another session alone', () => {
    accept('s1', 1);
    accept('o1', 1, 'session-b');
    expect(readRemainderMembers(store.db, SESSION, 10).map((row) => row.sourceId)).toEqual(['s1']);
  });

  /**
   * The remainder orders on the capture value and a NULL satisfies no bound, so a source without
   * one would drop out of every seal without a word. It is named instead.
   */
  it('names an unsealed source that carries no capture position', () => {
    accept('s1', 1);
    recordSourceRecord(store.db, {
      sourceId: 's-null',
      sessionId: SESSION,
      verificationStatus: 'verified',
      occurredAt: NOW.toISOString(),
      createdAt: NOW,
      archive: { ...ARCHIVE_PROOF, canonicalArchiveId: 'archive-s-null' },
    });
    expect(readRemainderMembers(store.db, SESSION, 10).map((row) => row.sourceId)).toEqual(['s1']);
    expect(unorderedSessionSources(store.db, SESSION)).toEqual(['s-null']);
  });
});

describe('what a revision rested on and cited', () => {
  const revision = buildEvidenceRevision([
    { kind: 'source', id: 's1', scope: 'source.content', version: 'v1' },
    { kind: 'relation_scope', id: 'claim-1', scope: 'sqlite:extraction:out', version: 'v2' },
  ]);

  it('indexes every dependency by its endpoint and refreshes a re-recorded token', () => {
    recordRevisionDependencies(store.db, 'node-1', revision);
    expect(revisionsDependingOn(store.db, 's1')).toEqual([
      {
        endpointId: 's1',
        relationClass: 'source.content',
        narrativeNodeId: 'node-1',
        versionToken: 'v1',
      },
    ]);
    recordRevisionDependencies(
      store.db,
      'node-1',
      buildEvidenceRevision([{ kind: 'source', id: 's1', scope: 'source.content', version: 'v9' }]),
    );
    expect(revisionsDependingOn(store.db, 's1')[0]?.versionToken).toBe('v9');
    expect(revisionsDependingOn(store.db, 'claim-1')).toHaveLength(1);
  });

  it('keeps two parts of one source as two citation targets', () => {
    store.db
      .prepare(
        `INSERT INTO chunk_revisions (chunk_id, revision_no, node_id, state, allocated_at, known_from)
         VALUES ('c1', 1, 'node-1', 'published', ?, ?)`,
      )
      .run(NOW.toISOString(), NOW.toISOString());
    recordRevisionCitations(store.db, 'node-1', [
      { targetId: 'part:s1:turn:0', targetKind: 'source_part' },
      { targetId: 'part:s1:turn:1', targetKind: 'source_part' },
    ]);
    // A repeat writes nothing new, which is what makes the acknowledgment replayable.
    recordRevisionCitations(store.db, 'node-1', [
      { targetId: 'part:s1:turn:0', targetKind: 'source_part' },
    ]);
    expect(readCitationsFrom(store.db, 'node-1')).toEqual([
      { targetId: 'part:s1:turn:0', targetKind: 'source_part' },
      { targetId: 'part:s1:turn:1', targetKind: 'source_part' },
    ]);
    expect(readCitationsOf(store.db, 'part:s1:turn:1')).toEqual([
      { narrativeNodeId: 'node-1', targetKind: 'source_part' },
    ]);
  });
});
