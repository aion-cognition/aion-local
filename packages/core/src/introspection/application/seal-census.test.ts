import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readSealDemand } from './seal-census.js';
import { sealChunk } from '../../infrastructure/sqlite/chunk-manifest.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import {
  allocateNarrativeRevision,
  blockRevisionAttempt,
  CHUNK_REVISION_FAMILY,
} from '../../infrastructure/sqlite/narrative-revisions.js';
import {
  beginSubstratePairing,
  completeSubstratePairing,
  setPendingOperation,
} from '../../infrastructure/sqlite/publication-control.js';
import { recordSourceRecord } from '../../infrastructure/sqlite/source-identity.js';
import {
  captureOrderValue,
  touchSessionRemainder,
} from '../../infrastructure/sqlite/source-lifecycle.js';

/**
 * The two halves of the reading, and the four ways they can disagree.
 *
 * The census and the pending publication answer different questions from different records, so a
 * substrate can know one and not the other in either direction. Every case below states which of
 * the two it established, because a reading nobody took must never come back as a healthy zero.
 */

const NOW = new Date('2026-09-09T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION = 'session-a';

const INPUT = { now: NOW, batch: 2, maxSpanMs: DAY_MS, maxMembers: 2 };

let store: SqliteStore;

function accept(sourceId: string, position: number, arrivedAt = NOW): void {
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
      archivedAt: arrivedAt.toISOString(),
    },
    occurredAt: arrivedAt.toISOString(),
    createdAt: arrivedAt,
    captureOrderValue: captureOrderValue(position),
    captureOrderBasis: 'archive_acceptance',
  });
  touchSessionRemainder(store.db, SESSION, captureOrderValue(position), NOW);
}

/** The pairing the coordinator writes at startup, which is what makes a pending reading possible. */
function pair(): void {
  const pairing = beginSubstratePairing(store.db, 1);
  completeSubstratePairing(store.db, pairing.substrateId);
}

beforeEach(() => {
  store = new SqliteStore({ filePath: ':memory:' });
});

afterEach(() => {
  store.close();
});

describe('the fresh census', () => {
  it('reports zero as a measured answer on a paired substrate with nothing to do', () => {
    pair();
    expect(readSealDemand(store.db, INPUT)).toEqual({
      eligibleGroups: 0,
      dueRemainders: 0,
      dueChunks: 0,
      inputCandidates: 0,
      oldestEligibleAgeMs: undefined,
      invalidatedHeads: 0,
      blockedSourcesByReason: {},
      blockedOldestAgeMs: undefined,
      pendingPublishedRepair: false,
      availability: 'measured',
    });
  });

  it('counts the two kinds of group apart and ages the oldest of them', () => {
    pair();
    const arrived = new Date(NOW.getTime() - 3 * DAY_MS);
    accept('s1', 1, arrived);
    accept('s2', 2, arrived);
    sealChunk(store.db, { sessionId: SESSION, sourceIds: ['s1'], sealedAt: arrived });

    // One chunk waiting for its first revision, and the tail `s2` is still standing in: two
    // groups of different kinds, each spending one unit of the same bounded run.
    const demand = readSealDemand(store.db, INPUT);
    expect(demand.dueChunks).toBe(1);
    expect(demand.dueRemainders).toBe(1);
    expect(demand.eligibleGroups).toBe(2);
    expect(demand.oldestEligibleAgeMs).toBe(3 * DAY_MS);
  });

  /** A blocked chunk sets no numerator and no oldest age; it is reported as its own population. */
  it('keeps a blocked chunk out of the eligible count and names what it holds', () => {
    pair();
    accept('s1', 1);
    const { chunkId } = sealChunk(store.db, {
      sessionId: SESSION,
      sourceIds: ['s1'],
      sealedAt: NOW,
    });
    const allocation = allocateNarrativeRevision(store.db, CHUNK_REVISION_FAMILY, chunkId, NOW);
    blockRevisionAttempt(
      store.db,
      CHUNK_REVISION_FAMILY,
      chunkId,
      allocation.revisionNo,
      'unscoped_coverage_gap',
    );

    const demand = readSealDemand(store.db, INPUT);
    expect(demand.eligibleGroups).toBe(0);
    expect(demand.oldestEligibleAgeMs).toBeUndefined();
    expect(demand.blockedSourcesByReason).toEqual({ unscoped_coverage_gap: 1 });
    expect(demand.blockedOldestAgeMs).toBe(0);
  });
});

describe('the two readings when one of them cannot be taken', () => {
  /**
   * The control record is what a pending publication is read from. An unpaired substrate has
   * none, which is not the same as nothing pending: the census still answers, and the pending
   * half says it could not be read rather than reporting a clean slate nobody verified.
   */
  it('answers the census and says the pending reading was not available', () => {
    accept('s1', 1);
    accept('s2', 2);
    const demand = readSealDemand(store.db, INPUT);
    expect(demand.availability).toBe('measured');
    expect(demand.eligibleGroups).toBe(1);
    expect(demand.pendingPublishedRepair).toBeUndefined();
    expect(demand.diagnostic).toContain('publication control record is unreadable');
  });

  it('carries a known pending publication through a census that failed', () => {
    pair();
    setPendingOperation(store.db, 'op-in-flight');
    // The manifest is out of reach. The census cannot answer and the pending reading still can.
    // Renamed rather than dropped: the store this test tears is the one the next test reads.
    store.db.prepare('ALTER TABLE chunks RENAME TO chunks_hidden').run();

    try {
      const demand = readSealDemand(store.db, INPUT);
      expect(demand.availability).toBe('unavailable');
      expect(demand.eligibleGroups).toBeUndefined();
      expect(demand.pendingPublishedRepair).toBe(true);
      expect(demand.diagnostic).toContain('census failed');
    } finally {
      store.db.prepare('ALTER TABLE chunks_hidden RENAME TO chunks').run();
    }
  });

  it('reports a pending publication beside a measured census', () => {
    pair();
    setPendingOperation(store.db, 'op-in-flight');
    const demand = readSealDemand(store.db, INPUT);
    expect(demand.availability).toBe('measured');
    expect(demand.eligibleGroups).toBe(0);
    expect(demand.pendingPublishedRepair).toBe(true);
  });
});
