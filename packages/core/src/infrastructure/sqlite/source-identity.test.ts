import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteStore } from './database.js';
import {
  acceptReferenceBatch,
  readReferenceDelivery,
  listReferenceBatches,
  readSourceRecord,
  recordSourceParts,
  recordSourceRecord,
  sourcePartAddress,
  type ArchiveProof,
} from './source-identity.js';

const OCCURRED_AT = '2026-09-01T00:00:00.000Z';
const NOW = new Date('2026-09-08T02:00:00.000Z');
const LATER = new Date('2026-09-08T03:00:00.000Z');

const PROOF: ArchiveProof = {
  canonicalArchiveId: 'archive-1',
  archiveSchemaVersion: 3,
  identityHash: 'identity-1',
  verifiedContentDigest: 'digest-1',
  verificationPolicyVersion: 1,
  archivedAt: '2026-09-01T00:00:01.000Z',
};

describe('source records', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-source-identity-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a status that is not verified and gives no reason', () => {
    expect(() => {
      recordSourceRecord(store.db, {
        sourceId: 'source-1',
        sessionId: 'session-1',
        verificationStatus: 'pinned',
        occurredAt: OCCURRED_AT,
        createdAt: NOW,
      });
    }).toThrow(/pinned with no reason given/);
  });

  it('refuses a verified claim with no archive proof behind it', () => {
    expect(() => {
      recordSourceRecord(store.db, {
        sourceId: 'source-1',
        sessionId: 'session-1',
        verificationStatus: 'verified',
        occurredAt: OCCURRED_AT,
        createdAt: NOW,
      });
    }).toThrow(/claims verification with no archive proof/);
  });

  it('keeps the identity when a pinned source is verified later', () => {
    recordSourceRecord(store.db, {
      sourceId: 'source-1',
      sessionId: 'session-1',
      verificationStatus: 'pinned',
      verificationReason: 'no archive row',
      occurredAt: OCCURRED_AT,
      createdAt: NOW,
    });
    expect(readSourceRecord(store.db, 'source-1')).toMatchObject({
      verificationStatus: 'pinned',
      canonicalArchiveId: null,
      archivedAt: null,
    });

    recordSourceRecord(store.db, {
      sourceId: 'source-1',
      sessionId: 'session-1',
      verificationStatus: 'verified',
      occurredAt: OCCURRED_AT,
      createdAt: LATER,
      archive: { ...PROOF, aliasArchiveIds: ['archive-2'] },
    });

    expect(readSourceRecord(store.db, 'source-1')).toMatchObject({
      sourceId: 'source-1',
      verificationStatus: 'verified',
      canonicalArchiveId: 'archive-1',
      aliasArchiveIds: ['archive-2'],
    });
    expect(store.db.prepare('SELECT count(*) AS n FROM source_records').get()).toEqual({ n: 1 });
  });

  it('writes a source that was forgotten and pushed again as its own occurrence', () => {
    for (const sourceId of ['episode-1', 'episode-1-repush']) {
      recordSourceRecord(store.db, {
        sourceId,
        sessionId: 'session-1',
        verificationStatus: 'unresolved',
        verificationReason: 'awaiting verification',
        occurredAt: OCCURRED_AT,
        createdAt: NOW,
      });
    }

    expect(store.db.prepare('SELECT count(*) AS n FROM source_records').get()).toEqual({ n: 2 });
  });

  it('writes parts and re-running the batch changes nothing', () => {
    const parts = [
      { partKind: 'turn' as const, ordinal: 0, turnId: 'turn-1', contentHash: 'hash-a' },
      { partKind: 'observation' as const, ordinal: 0, contentHash: 'hash-b' },
      { partKind: 'observation' as const, ordinal: 1, contentHash: 'hash-c' },
    ];
    recordSourceParts(store.db, 'source-1', parts);
    recordSourceParts(store.db, 'source-1', parts);

    expect(store.db.prepare('SELECT count(*) AS n FROM source_parts').get()).toEqual({ n: 3 });
    expect(sourcePartAddress('source-1', 'observation', 0)).toBe('part:source-1:observation:0');
    expect(sourcePartAddress('source-1', 'observation', 1)).not.toBe(
      sourcePartAddress('source-1', 'observation', 0),
    );
  });

  it('leaves a role null rather than inferring one', () => {
    recordSourceParts(store.db, 'source-1', [
      { partKind: 'observation', ordinal: 0, contentHash: 'hash-a' },
    ]);

    expect(store.db.prepare('SELECT role FROM source_parts').get()).toEqual({ role: null });
  });
});

describe('reference batches', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-reference-batches-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('records the present set as version 1', () => {
    const outcome = acceptReferenceBatch(store.db, {
      sourceId: 'source-1',
      acceptedHash: 'set-a',
      receivedAt: NOW,
      operationKey: 'op-1',
      introduced: ['ref-1', 'ref-2'],
    });

    expect(outcome).toEqual({ referenceVersion: 1, added: true });
    expect(listReferenceBatches(store.db, 'source-1')).toMatchObject([
      { referenceVersion: 1, acceptedHash: 'set-a' },
    ]);
  });

  it('adds no version for a batch that repeats the accepted set', () => {
    acceptReferenceBatch(store.db, {
      sourceId: 'source-1',
      acceptedHash: 'set-a',
      receivedAt: NOW,
      operationKey: 'op-1',
      introduced: ['ref-1'],
    });

    expect(
      acceptReferenceBatch(store.db, {
        sourceId: 'source-1',
        acceptedHash: 'set-a',
        receivedAt: LATER,
        operationKey: 'op-2',
        introduced: [],
      }),
    ).toEqual({ referenceVersion: 1, added: false });
    expect(listReferenceBatches(store.db, 'source-1')).toHaveLength(1);
  });

  it('returns the version a retried delivery already produced', () => {
    const first = acceptReferenceBatch(store.db, {
      sourceId: 'source-1',
      acceptedHash: 'set-a',
      receivedAt: NOW,
      operationKey: 'op-1',
      introduced: ['ref-1'],
    });
    const retried = acceptReferenceBatch(store.db, {
      sourceId: 'source-1',
      acceptedHash: 'set-a',
      receivedAt: LATER,
      operationKey: 'op-1',
      introduced: ['ref-1'],
    });

    expect(retried).toEqual({ referenceVersion: first.referenceVersion, added: false });
  });

  it('reads back a no-change delivery through the receipt that bound it', () => {
    acceptReferenceBatch(store.db, {
      sourceId: 'source-1',
      acceptedHash: 'set-a',
      receivedAt: NOW,
      operationKey: 'op-a',
      introduced: ['ref-a'],
    });
    const noChange = acceptReferenceBatch(store.db, {
      sourceId: 'source-1',
      acceptedHash: 'set-a',
      receivedAt: LATER,
      operationKey: 'op-duplicate',
      introduced: [],
    });

    expect(noChange.added).toBe(false);
    expect(readReferenceDelivery(store.db, 'source-1', 'op-duplicate')).toEqual({
      referenceVersion: noChange.referenceVersion,
      acceptedHash: 'set-a',
    });
    expect(readReferenceDelivery(store.db, 'source-1', 'op-a')).toEqual({
      referenceVersion: 1,
      acceptedHash: 'set-a',
    });
    expect(readReferenceDelivery(store.db, 'source-1', 'never-delivered')).toBeUndefined();
    expect(listReferenceBatches(store.db, 'source-1')).toHaveLength(1);
  });

  it('a no-change delivery retried after a later set still returns its original result', () => {
    const path = join(dir, 'deliveries.sqlite');
    const first = new SqliteStore({ filePath: path });
    const noChange = {
      sourceId: 'source-1',
      acceptedHash: 'set-a',
      receivedAt: NOW,
      operationKey: 'duplicate',
      introduced: [],
    };

    acceptReferenceBatch(first.db, {
      sourceId: 'source-1',
      acceptedHash: 'set-a',
      receivedAt: NOW,
      operationKey: 'op-a',
      introduced: ['ref-a'],
    });
    const original = acceptReferenceBatch(first.db, noChange);
    acceptReferenceBatch(first.db, {
      sourceId: 'source-1',
      acceptedHash: 'set-ab',
      receivedAt: LATER,
      operationKey: 'op-ab',
      introduced: ['ref-b'],
    });
    expect(original).toEqual({ referenceVersion: 1, added: false });
    first.close();

    const reopened = new SqliteStore({ filePath: path });
    try {
      expect(acceptReferenceBatch(reopened.db, noChange)).toEqual(original);

      const history = listReferenceBatches(reopened.db, 'source-1');
      expect(history).toHaveLength(2);
      expect(history.at(-1)?.acceptedHash).toBe('set-ab');
      expect(
        reopened.db.prepare('SELECT count(*) AS n FROM source_reference_batches').get(),
      ).toEqual({ n: 2 });
    } finally {
      reopened.close();
    }
  });

  it('refuses one operation key standing for two different accepted sets', () => {
    acceptReferenceBatch(store.db, {
      sourceId: 'source-1',
      acceptedHash: 'set-a',
      receivedAt: NOW,
      operationKey: 'op-a',
      introduced: ['ref-a'],
    });

    expect(() => {
      acceptReferenceBatch(store.db, {
        sourceId: 'source-1',
        acceptedHash: 'set-other',
        receivedAt: LATER,
        operationKey: 'op-a',
        introduced: ['ref-x'],
      });
    }).toThrow(/already accepted a different set/);

    // The same refusal covers a delivery whose recorded result allocated no version.
    acceptReferenceBatch(store.db, {
      sourceId: 'source-1',
      acceptedHash: 'set-a',
      receivedAt: NOW,
      operationKey: 'op-repeat',
      introduced: [],
    });
    expect(() => {
      acceptReferenceBatch(store.db, {
        sourceId: 'source-1',
        acceptedHash: 'set-other',
        receivedAt: LATER,
        operationKey: 'op-repeat',
        introduced: [],
      });
    }).toThrow(/already accepted a different set/);
    expect(listReferenceBatches(store.db, 'source-1')).toHaveLength(1);
  });

  it('gives a changed set its own version and keeps what came before', () => {
    acceptReferenceBatch(store.db, {
      sourceId: 'source-1',
      acceptedHash: 'set-a',
      receivedAt: NOW,
      operationKey: 'op-1',
      introduced: ['ref-1'],
    });
    const second = acceptReferenceBatch(store.db, {
      sourceId: 'source-1',
      acceptedHash: 'set-b',
      receivedAt: LATER,
      operationKey: 'op-2',
      introduced: ['ref-2'],
    });

    expect(second).toEqual({ referenceVersion: 2, added: true });
    expect(listReferenceBatches(store.db, 'source-1').map((row) => row.acceptedHash)).toEqual([
      'set-a',
      'set-b',
    ]);
  });
});
