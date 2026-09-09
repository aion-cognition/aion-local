import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteStore } from './database.js';
import { ensureSearchProjection } from './fts-capability.js';
import { recordSourceParts, recordSourceRecord } from './source-identity.js';
import {
  corpusCoverage,
  documentHighWater,
  LIVE_INDEX_STREAM,
  MIGRATION_INDEX_STREAM,
  nominateDocuments,
  readIndexProgress,
  readSearchDocument,
  recordIndexProgress,
  searchGeneration,
  searchIndexPin,
  writeSearchDocument,
  type SearchDocumentInput,
} from './source-search-store.js';

const OCCURRED_AT = '2026-09-01T00:00:00.000Z';

function document(overrides: Partial<SearchDocumentInput> = {}): SearchDocumentInput {
  const body = overrides.body ?? 'the costs qualifier arrived late';
  return {
    sourceId: 'source-1',
    partKind: 'turn',
    partOrdinal: 0,
    contentDigest: 'digest-1',
    truncated: false,
    indexedBytes: Buffer.byteLength(body, 'utf8'),
    ...overrides,
    body,
  };
}

describe('search projection store', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-search-store-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
    ensureSearchProjection(store.db);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends a document without moving the generation', () => {
    expect(searchGeneration(store.db)).toBe(1);
    expect(writeSearchDocument(store.db, document())).toBe('appended');
    expect(searchGeneration(store.db)).toBe(1);
    expect(documentHighWater(store.db)).toBe(1);
  });

  it('leaves an unchanged document exactly as it is', () => {
    writeSearchDocument(store.db, document());
    expect(writeSearchDocument(store.db, document())).toBe('unchanged');
    expect(searchGeneration(store.db)).toBe(1);
    expect(documentHighWater(store.db)).toBe(1);
  });

  it('bumps the generation on every replacement of an existing document', () => {
    writeSearchDocument(store.db, document());
    expect(
      writeSearchDocument(store.db, document({ contentDigest: 'digest-2', body: 'a later text' })),
    ).toBe('replaced');
    expect(searchGeneration(store.db)).toBe(2);
    expect(
      writeSearchDocument(store.db, document({ contentDigest: 'digest-3', body: 'a third text' })),
    ).toBe('replaced');
    expect(searchGeneration(store.db)).toBe(3);
    // The replacement keeps its address and its id, so an outstanding cursor is invalidated by
    // the generation rather than by a row that moved out from under it.
    expect(documentHighWater(store.db)).toBe(1);
    expect(readSearchDocument(store.db, 'source-1', 'turn', 0)?.contentDigest).toBe('digest-3');
  });

  it('replaces the indexed body rather than leaving both readings findable', () => {
    writeSearchDocument(store.db, document({ body: 'the original phrase' }));
    writeSearchDocument(
      store.db,
      document({ contentDigest: 'digest-2', body: 'the replacement phrase' }),
    );
    const high = documentHighWater(store.db);
    const stale = nominateDocuments(store.db, {
      matchExpression: '"original"',
      afterId: 0,
      upperBound: high,
      limit: 10,
    });
    expect(stale).toEqual([]);
    const current = nominateDocuments(store.db, {
      matchExpression: '"replacement"',
      afterId: 0,
      upperBound: high,
      limit: 10,
    });
    expect(current.map((row) => row.partOrdinal)).toEqual([0]);
  });

  it('nominates in document order, bounded above and below', () => {
    writeSearchDocument(store.db, document({ partOrdinal: 0, body: 'alpha shared' }));
    writeSearchDocument(store.db, document({ partOrdinal: 1, body: 'beta shared' }));
    writeSearchDocument(store.db, document({ partOrdinal: 2, body: 'gamma shared' }));
    const all = nominateDocuments(store.db, {
      matchExpression: '"shared"',
      afterId: 0,
      upperBound: 3,
      limit: 10,
    });
    expect(all.map((row) => row.id)).toEqual([1, 2, 3]);
    const page = nominateDocuments(store.db, {
      matchExpression: '"shared"',
      afterId: 1,
      upperBound: 2,
      limit: 10,
    });
    expect(page.map((row) => row.id)).toEqual([2]);
  });

  it('reports truncated documents as corpus coverage even with nothing else stored', () => {
    expect(corpusCoverage(store.db)).toEqual({
      documents: 0,
      truncatedDocuments: 0,
      recordedParts: 0,
      coveredParts: 0,
    });
    writeSearchDocument(store.db, document({ truncated: true, indexedBytes: 12 }));
    expect(corpusCoverage(store.db)).toMatchObject({ documents: 1, truncatedDocuments: 1 });
  });

  it('counts a captured part nobody has indexed as corpus the search cannot answer for', () => {
    recordSourceRecord(store.db, {
      sourceId: 'source-2',
      sessionId: 'session-1',
      verificationStatus: 'pinned',
      verificationReason: 'test fixture',
      occurredAt: OCCURRED_AT,
      createdAt: new Date(OCCURRED_AT),
    });
    recordSourceParts(store.db, 'source-2', [
      { partKind: 'turn', ordinal: 0, contentHash: 'part-0' },
    ]);

    // Cardinality would call this covered as soon as any one document exists. Identity does
    // not: the document below belongs to a different source entirely.
    writeSearchDocument(store.db, document({ sourceId: 'source-1', partOrdinal: 0 }));
    const coverage = corpusCoverage(store.db);

    expect(coverage.recordedParts).toBe(1);
    expect(coverage.coveredParts).toBe(0);
    expect(coverage.documents).toBe(1);
  });

  it('does not count a document written under an older index policy as coverage', () => {
    recordSourceRecord(store.db, {
      sourceId: 'source-3',
      sessionId: 'session-1',
      verificationStatus: 'pinned',
      verificationReason: 'test fixture',
      occurredAt: OCCURRED_AT,
      createdAt: new Date(OCCURRED_AT),
    });
    recordSourceParts(store.db, 'source-3', [
      { partKind: 'turn', ordinal: 0, contentHash: 'part-0' },
    ]);
    writeSearchDocument(
      store.db,
      document({ sourceId: 'source-3', partOrdinal: 0, contentDigest: 'part-0' }),
    );
    expect(searchIndexPin(store.db, 'source-3')).toEqual({ pinned: false });

    store.db
      .prepare('UPDATE source_search_documents SET index_policy_version = 0 WHERE source_id = ?')
      .run('source-3');

    expect(searchIndexPin(store.db, 'source-3')).toMatchObject({
      pinned: true,
      reason: 'unindexed_parts',
    });
  });

  it('keeps each stream cursor apart and leaves the generation alone', () => {
    recordIndexProgress(store.db, {
      stream: LIVE_INDEX_STREAM,
      cursor: 'source-1:turn:3',
      state: 'running',
    });
    recordIndexProgress(store.db, {
      stream: MIGRATION_INDEX_STREAM,
      cursor: 'source-9:turn:0',
      state: 'running',
    });
    expect(readIndexProgress(store.db, LIVE_INDEX_STREAM)?.cursor).toBe('source-1:turn:3');
    expect(readIndexProgress(store.db, MIGRATION_INDEX_STREAM)?.cursor).toBe('source-9:turn:0');
    expect(searchGeneration(store.db)).toBe(1);
  });

  describe('the eviction pin', () => {
    beforeEach(() => {
      recordSourceRecord(store.db, {
        sourceId: 'source-1',
        sessionId: 'session-1',
        verificationStatus: 'pinned',
        verificationReason: 'test fixture',
        occurredAt: OCCURRED_AT,
        createdAt: new Date(OCCURRED_AT),
      });
      recordSourceParts(store.db, 'source-1', [
        { partKind: 'turn', ordinal: 0, contentHash: 'part-0' },
        { partKind: 'turn', ordinal: 1, contentHash: 'part-1' },
      ]);
    });

    it('pins a source whose parts are not all indexed', () => {
      expect(searchIndexPin(store.db, 'source-1')).toEqual({
        pinned: true,
        reason: 'unindexed_parts',
        parts: 2,
      });
      writeSearchDocument(store.db, document({ partOrdinal: 0, contentDigest: 'part-0' }));
      expect(searchIndexPin(store.db, 'source-1')).toMatchObject({
        pinned: true,
        reason: 'unindexed_parts',
        parts: 1,
      });
    });

    it('pins a source holding a truncated document and releases it on a complete reindex', () => {
      // A truncated document never carries the part's content identity: it holds a prefix, so
      // claiming that hash would be a claim to hold the whole part.
      writeSearchDocument(
        store.db,
        document({ partOrdinal: 0, contentDigest: 'prefix:part-0', truncated: true }),
      );
      writeSearchDocument(store.db, document({ partOrdinal: 1, contentDigest: 'part-1' }));
      expect(searchIndexPin(store.db, 'source-1')).toMatchObject({
        pinned: true,
        reason: 'truncated_parts',
      });
      writeSearchDocument(
        store.db,
        document({ partOrdinal: 0, contentDigest: 'part-0', truncated: false }),
      );
      expect(searchIndexPin(store.db, 'source-1')).toEqual({ pinned: false });
    });
  });
});
