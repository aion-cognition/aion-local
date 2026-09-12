import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { sealChunk } from './chunk-manifest.js';
import {
  blockedChunkSources,
  dueChunkGroups,
  dueRemainderGroups,
  heldRemainderMembership,
} from './chunk-nomination.js';
import { SqliteStore } from './database.js';
import {
  allocateNarrativeRevision,
  blockRevisionAttempt,
  CHUNK_REVISION_FAMILY,
  deferRevisionAttempt,
  publishNarrativeRevision,
} from './narrative-revisions.js';
import { recordSourceRecord, type SourceVerificationStatus } from './source-identity.js';
import { captureOrderValue, touchSessionRemainder } from './source-lifecycle.js';

/**
 * What durable state alone can say about the chunk lifecycle's backlog.
 *
 * Every case here writes the records a live acceptance writes and then asks the nomination reads
 * what they see, because the whole point of these reads is that the observation tick has neither
 * a resolver nor a graph and still has to produce a demand number nobody has to qualify.
 */

const NOW = new Date('2026-09-09T12:00:00.000Z');
const SESSION = 'session-a';
const DAY_MS = 24 * 60 * 60 * 1000;

const ARCHIVE_PROOF = {
  archiveSchemaVersion: 1,
  identityHash: 'identity-1',
  verifiedContentDigest: 'digest-1',
  verificationPolicyVersion: 1,
  archivedAt: NOW.toISOString(),
};

let store: SqliteStore;

type AcceptInput = {
  readonly sourceId: string;
  readonly position: number;
  readonly sessionId?: string;
  readonly arrivedAt?: Date;
  readonly occurredAt?: Date;
  readonly verificationStatus?: SourceVerificationStatus;
};

function accept(input: AcceptInput): void {
  const sessionId = input.sessionId ?? SESSION;
  const status = input.verificationStatus ?? 'verified';
  recordSourceRecord(store.db, {
    sourceId: input.sourceId,
    sessionId,
    verificationStatus: status,
    ...(status === 'verified'
      ? { archive: { ...ARCHIVE_PROOF, canonicalArchiveId: `archive-${input.sourceId}` } }
      : { verificationReason: 'no archive proof was ever recorded' }),
    occurredAt: (input.occurredAt ?? NOW).toISOString(),
    createdAt: input.arrivedAt ?? NOW,
    captureOrderValue: captureOrderValue(input.position),
    captureOrderBasis: 'archive_acceptance',
  });
  touchSessionRemainder(store.db, sessionId, captureOrderValue(input.position), NOW);
}

function remainders(overrides: { maxMembers?: number; now?: Date } = {}) {
  return dueRemainderGroups(store.db, {
    now: overrides.now ?? NOW,
    maxSpanMs: DAY_MS,
    maxMembers: overrides.maxMembers ?? 2,
    limit: 10,
  });
}

beforeEach(() => {
  store = new SqliteStore({ filePath: ':memory:' });
});

afterEach(() => {
  store.close();
});

describe('a session tail that is due to seal', () => {
  it('waits below both triggers and is due once the member count reaches the bound', () => {
    accept({ sourceId: 's1', position: 1 });
    expect(remainders()).toEqual([]);

    accept({ sourceId: 's2', position: 2 });
    expect(remainders().map((group) => group.sessionId)).toEqual([SESSION]);
    expect(remainders()[0]?.unsealed).toBe(2);
  });

  /**
   * The span trigger measures how long the tail has been standing, not what world time the
   * caller stated. A conversation about last year is not a day-old tail, and reading
   * `occurred_at` here would make every backdated source permanently overdue.
   */
  it('measures the span on arrival rather than on a backdated occurrence', () => {
    accept({
      sourceId: 'backdated',
      position: 1,
      occurredAt: new Date(NOW.getTime() - 400 * DAY_MS),
    });
    expect(remainders()).toEqual([]);

    accept({
      sourceId: 'old-arrival',
      position: 2,
      sessionId: 'session-b',
      arrivedAt: new Date(NOW.getTime() - 2 * DAY_MS),
    });
    expect(remainders({ maxMembers: 99 }).map((group) => group.sessionId)).toEqual(['session-b']);
  });

  it('drops a tail out once its members are sealed', () => {
    accept({ sourceId: 's1', position: 1 });
    accept({ sourceId: 's2', position: 2 });
    sealChunk(store.db, { sessionId: SESSION, sourceIds: ['s1', 's2'], sealedAt: NOW });
    expect(remainders()).toEqual([]);
  });

  it('resumes strictly past the group a cursor names, and reaches it again from the front', () => {
    accept({ sourceId: 'a1', position: 1, sessionId: 'session-a' });
    accept({ sourceId: 'a2', position: 2, sessionId: 'session-a' });
    accept({ sourceId: 'b1', position: 3, sessionId: 'session-b' });
    accept({ sourceId: 'b2', position: 4, sessionId: 'session-b' });

    const page = remainders();
    expect(page.map((group) => group.sessionId)).toEqual(['session-a', 'session-b']);

    const after = page[0];
    if (after === undefined) {
      throw new Error('the first page must hold a group');
    }
    const resumed = dueRemainderGroups(store.db, {
      now: NOW,
      maxSpanMs: DAY_MS,
      maxMembers: 2,
      limit: 10,
      after: { captureKey: after.captureKey, sessionId: after.sessionId },
    });
    expect(resumed.map((group) => group.sessionId)).toEqual(['session-b']);
    // The cursor settled nothing: the group it moved past is nominated again from the front.
    expect(remainders().map((group) => group.sessionId)).toEqual(['session-a', 'session-b']);
  });
});

describe('membership a source is not proved for', () => {
  /**
   * A verified identity is a precondition of membership. An unresolved source waiting outside
   * every chunk is the correct answer and a silent one, so the count travels with the demand
   * rather than the source simply never being narrated.
   */
  it('is outside the eligible tail and counted by itself', () => {
    accept({ sourceId: 's1', position: 1 });
    accept({ sourceId: 's2', position: 2, verificationStatus: 'unresolved' });
    accept({ sourceId: 's3', position: 3, verificationStatus: 'pinned' });

    expect(remainders()).toEqual([]);
    expect(heldRemainderMembership(store.db)).toEqual({
      sources: 2,
      oldestAt: NOW.toISOString(),
    });
  });
});

describe('a sealed chunk that is due to publish', () => {
  function seal(sourceIds: readonly string[]): string {
    return sealChunk(store.db, { sessionId: SESSION, sourceIds, sealedAt: NOW }).chunkId;
  }

  it('is due with no attempt behind it and gone once a head stands', () => {
    accept({ sourceId: 's1', position: 1 });
    const chunkId = seal(['s1']);
    expect(dueChunkGroups(store.db, NOW, 10).map((group) => group.chunkId)).toEqual([chunkId]);

    const allocation = allocateNarrativeRevision(store.db, CHUNK_REVISION_FAMILY, chunkId, NOW);
    publishNarrativeRevision(store.db, CHUNK_REVISION_FAMILY, {
      familyKey: chunkId,
      revisionNo: allocation.revisionNo,
      operationId: 'op-1',
      evidenceRevisionJson: '{"dependencies":[]}',
      knownFrom: NOW.toISOString(),
      observedAckAt: NOW.toISOString(),
      publishedAt: NOW,
    });
    expect(dueChunkGroups(store.db, NOW, 10)).toEqual([]);
  });

  it('waits while its attempt is dated later and returns when that time arrives', () => {
    accept({ sourceId: 's1', position: 1 });
    const chunkId = seal(['s1']);
    const allocation = allocateNarrativeRevision(store.db, CHUNK_REVISION_FAMILY, chunkId, NOW);
    const later = new Date(NOW.getTime() + 60 * 60 * 1000);
    deferRevisionAttempt(store.db, CHUNK_REVISION_FAMILY, chunkId, allocation.revisionNo, later);

    expect(dueChunkGroups(store.db, NOW, 10)).toEqual([]);
    expect(dueChunkGroups(store.db, later, 10).map((group) => group.chunkId)).toEqual([chunkId]);
  });

  /**
   * A block clears on a changed prerequisite and never on the clock, so a blocked chunk is not
   * nominated at any later time. What it is instead is visible: a source count under the reason
   * the attempt recorded.
   */
  it('is out of nomination while blocked, and counted by reason instead', () => {
    accept({ sourceId: 's1', position: 1 });
    accept({ sourceId: 's2', position: 2 });
    const chunkId = seal(['s1', 's2']);
    const allocation = allocateNarrativeRevision(store.db, CHUNK_REVISION_FAMILY, chunkId, NOW);
    blockRevisionAttempt(
      store.db,
      CHUNK_REVISION_FAMILY,
      chunkId,
      allocation.revisionNo,
      'member_evidence_missing',
    );

    expect(dueChunkGroups(store.db, new Date(NOW.getTime() + 400 * DAY_MS), 10)).toEqual([]);
    expect(blockedChunkSources(store.db)).toEqual([
      { reason: 'member_evidence_missing', sources: 2, oldestAt: NOW.toISOString() },
    ]);
  });

  it('nominates in capture order rather than in seal order', () => {
    accept({ sourceId: 'late', position: 9 });
    accept({ sourceId: 'early', position: 1 });
    const second = seal(['late']);
    const first = seal(['early']);
    expect(dueChunkGroups(store.db, NOW, 10).map((group) => group.chunkId)).toEqual([
      first,
      second,
    ]);
  });
});
