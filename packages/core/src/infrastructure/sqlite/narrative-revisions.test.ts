import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteStore } from './database.js';
import {
  abandonNarrativeRevision,
  allocateNarrativeRevision,
  blockRevisionAttempt,
  CHUNK_REVISION_FAMILY,
  clearRevisionBlock,
  narrativeRevisionNodeId,
  nominateRetryableRevisions,
  OVERVIEW_REVISION_FAMILY,
  publishNarrativeRevision,
  readNarrativeRevision,
  readPublishedHead,
  recordRevisionAttemptFailure,
  type NarrativePublication,
  type RevisionFamily,
} from './narrative-revisions.js';

const EARLY = new Date('2026-09-08T01:00:00.000Z');
const NOW = new Date('2026-09-08T02:00:00.000Z');
const LATER = new Date('2026-09-08T03:00:00.000Z');

function publication(
  familyKey: string,
  revisionNo: number,
  overrides: Partial<NarrativePublication> = {},
): NarrativePublication {
  return {
    familyKey,
    revisionNo,
    operationId: `op-${familyKey}-${revisionNo}`,
    evidenceRevisionJson: '{"contractVersion":1,"dependencies":[],"digest":"d"}',
    knownFrom: NOW.toISOString(),
    observedAckAt: NOW.toISOString(),
    publishedAt: NOW,
    ...overrides,
  };
}

describe('narrative revision allocation', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-revisions-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
    store.db
      .prepare(
        `INSERT INTO chunks
           (chunk_id, session_id, partition_policy_version, state, sealed_at, member_count, created_at)
         VALUES ('chunk-1', 'session-1', 1, 'sealed', ?, 2, ?)`,
      )
      .run(EARLY.toISOString(), EARLY.toISOString());
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const families: readonly [string, RevisionFamily, string][] = [
    ['chunks', CHUNK_REVISION_FAMILY, 'chunk-1'],
    ['overviews', OVERVIEW_REVISION_FAMILY, 'calendar:2026-W36'],
  ];

  it.each(families)(
    '%s: an abandoned allocation is spent, and the head moves only when a publication lands',
    (_name, family, key) => {
      const first = allocateNarrativeRevision(store.db, family, key, EARLY);
      expect(first.revisionNo).toBe(1);
      expect(readPublishedHead(store.db, family, key)).toBeUndefined();

      publishNarrativeRevision(store.db, family, publication(key, 1));
      expect(readPublishedHead(store.db, family, key)).toBe(1);

      const second = allocateNarrativeRevision(store.db, family, key, EARLY);
      expect(second.revisionNo).toBe(2);
      expect(abandonNarrativeRevision(store.db, family, key, 2, NOW)).toBe(true);
      // The head did not follow the abandoned attempt.
      expect(readPublishedHead(store.db, family, key)).toBe(1);

      const third = allocateNarrativeRevision(store.db, family, key, EARLY);
      expect(third.revisionNo).toBe(3);

      const outcome = publishNarrativeRevision(store.db, family, publication(key, 3));
      expect(outcome).toEqual({ supersededRevisionNo: 1 });
      expect(readPublishedHead(store.db, family, key)).toBe(3);
      expect(readNarrativeRevision(store.db, family, key, 1)?.state).toBe('closed');
      expect(readNarrativeRevision(store.db, family, key, 2)?.state).toBe('abandoned');
    },
  );

  it.each(families)('%s: an abandoned revision cannot publish later', (_name, family, key) => {
    allocateNarrativeRevision(store.db, family, key, EARLY);
    abandonNarrativeRevision(store.db, family, key, 1, NOW);

    expect(() => publishNarrativeRevision(store.db, family, publication(key, 1))).toThrow(
      /abandoned and cannot publish/,
    );
    expect(readPublishedHead(store.db, family, key)).toBeUndefined();
  });

  it.each(families)('%s: a number nobody allocated cannot publish', (_name, family, key) => {
    expect(() => publishNarrativeRevision(store.db, family, publication(key, 7))).toThrow(
      /was never allocated/,
    );
  });

  it.each(families)('%s: the node id is the family key and the number', (_name, family, key) => {
    const { nodeId } = allocateNarrativeRevision(store.db, family, key, EARLY);
    expect(nodeId).toBe(narrativeRevisionNodeId(key, 1));
    expect(nodeId).not.toBe(narrativeRevisionNodeId(key, 2));
  });

  it('a spent number stays spent across a close and reopen', () => {
    const path = join(dir, 'restart.sqlite');
    const first = new SqliteStore({ filePath: path });
    allocateNarrativeRevision(first.db, OVERVIEW_REVISION_FAMILY, 'calendar:2026-W36', EARLY);
    const second = allocateNarrativeRevision(
      first.db,
      OVERVIEW_REVISION_FAMILY,
      'calendar:2026-W36',
      EARLY,
    );
    abandonNarrativeRevision(first.db, OVERVIEW_REVISION_FAMILY, 'calendar:2026-W36', 2, NOW);
    expect(second.revisionNo).toBe(2);
    first.close();

    const reopened = new SqliteStore({ filePath: path });
    try {
      const third = allocateNarrativeRevision(
        reopened.db,
        OVERVIEW_REVISION_FAMILY,
        'calendar:2026-W36',
        EARLY,
      );
      expect(third.revisionNo).toBe(3);
      expect(
        reopened.db
          .prepare('SELECT allocated_high_water FROM overview_registry WHERE family_key = ?')
          .get('calendar:2026-W36'),
      ).toEqual({ allocated_high_water: 3 });
    } finally {
      reopened.close();
    }
  });

  it('publishing into a chunk that was never sealed is refused rather than inventing the row', () => {
    allocateNarrativeRevision(store.db, CHUNK_REVISION_FAMILY, 'chunk-absent', EARLY);

    expect(() =>
      publishNarrativeRevision(store.db, CHUNK_REVISION_FAMILY, publication('chunk-absent', 1)),
    ).toThrow(/has no row for chunk-absent/);
  });

  it('two chunks publish without superseding each other', () => {
    store.db
      .prepare(
        `INSERT INTO chunks
           (chunk_id, session_id, partition_policy_version, state, sealed_at, member_count, created_at)
         VALUES ('chunk-2', 'session-1', 1, 'sealed', ?, 1, ?)`,
      )
      .run(EARLY.toISOString(), EARLY.toISOString());

    allocateNarrativeRevision(store.db, CHUNK_REVISION_FAMILY, 'chunk-1', EARLY);
    allocateNarrativeRevision(store.db, CHUNK_REVISION_FAMILY, 'chunk-2', EARLY);
    publishNarrativeRevision(store.db, CHUNK_REVISION_FAMILY, publication('chunk-1', 1));
    const outcome = publishNarrativeRevision(
      store.db,
      CHUNK_REVISION_FAMILY,
      publication('chunk-2', 1),
    );

    expect(outcome).toEqual({});
    expect(readNarrativeRevision(store.db, CHUNK_REVISION_FAMILY, 'chunk-1', 1)?.state).toBe(
      'published',
    );
    // Each chunk numbers its own revisions.
    expect(readPublishedHead(store.db, CHUNK_REVISION_FAMILY, 'chunk-2')).toBe(1);
  });
});

describe('narrative revision retry nomination', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-revision-retry-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const families: readonly [string, RevisionFamily, string][] = [
    ['chunks', CHUNK_REVISION_FAMILY, 'chunk'],
    ['overviews', OVERVIEW_REVISION_FAMILY, 'calendar:'],
  ];

  it.each(families)(
    '%s: nomination takes the due rows, skips blocked and future ones, and seeks the retry index',
    (_name, family, prefix) => {
      for (const suffix of ['due', 'blocked', 'future', 'pending', 'abandoned']) {
        allocateNarrativeRevision(store.db, family, prefix + suffix, EARLY);
      }
      blockRevisionAttempt(store.db, family, `${prefix}blocked`, 1, 'required_scope_missing');
      recordRevisionAttemptFailure(store.db, family, {
        familyKey: `${prefix}future`,
        revisionNo: 1,
        reason: 'store_unavailable',
        nextAttemptAt: LATER,
      });
      store.db
        .prepare(
          `UPDATE ${family.revisionTable} SET state = 'prepared' WHERE ${family.keyColumn} = ?`,
        )
        .run(`${prefix}pending`);
      abandonNarrativeRevision(store.db, family, `${prefix}abandoned`, 1, NOW);

      const nominated = nominateRetryableRevisions(store.db, family, NOW, 10);
      expect(nominated.map((row) => row.familyKey)).toEqual([`${prefix}due`]);

      const plan = store.db
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT ${family.keyColumn} FROM ${family.revisionTable}
           WHERE state = 'allocated' AND blocked_reason IS NULL
             AND COALESCE(next_attempt_at, allocated_at) <= ?
           ORDER BY COALESCE(next_attempt_at, allocated_at), ${family.keyColumn}, revision_no`,
        )
        .all(NOW.toISOString()) as { detail: string }[];
      expect(plan.some((row) => row.detail.includes(`${family.revisionTable}_retry_idx`))).toBe(
        true,
      );
    },
  );

  it.each(families)(
    '%s: a future attempt comes back once its retry time has passed',
    (_name, family, prefix) => {
      allocateNarrativeRevision(store.db, family, `${prefix}late`, EARLY);
      recordRevisionAttemptFailure(store.db, family, {
        familyKey: `${prefix}late`,
        revisionNo: 1,
        reason: 'store_unavailable',
        nextAttemptAt: LATER,
      });

      expect(nominateRetryableRevisions(store.db, family, NOW, 10)).toEqual([]);

      const [row] = nominateRetryableRevisions(store.db, family, LATER, 10);
      expect(row).toMatchObject({
        familyKey: `${prefix}late`,
        attempts: 1,
        lastFailureReason: 'store_unavailable',
      });
    },
  );

  it.each(families)(
    '%s: a block clears only when it is cleared, never by the clock',
    (_name, family, prefix) => {
      allocateNarrativeRevision(store.db, family, `${prefix}held`, EARLY);
      blockRevisionAttempt(store.db, family, `${prefix}held`, 1, 'evidence_incomplete');

      expect(nominateRetryableRevisions(store.db, family, LATER, 10)).toEqual([]);

      expect(clearRevisionBlock(store.db, family, `${prefix}held`, 1)).toBe(true);
      expect(nominateRetryableRevisions(store.db, family, LATER, 10)).toHaveLength(1);
      // A second clear finds nothing to clear and says so.
      expect(clearRevisionBlock(store.db, family, `${prefix}held`, 1)).toBe(false);
    },
  );

  it.each(families)(
    '%s: nomination is oldest effective due time first',
    (_name, family, prefix) => {
      allocateNarrativeRevision(store.db, family, `${prefix}a`, NOW);
      allocateNarrativeRevision(store.db, family, `${prefix}b`, EARLY);

      expect(
        nominateRetryableRevisions(store.db, family, LATER, 10).map((row) => row.familyKey),
      ).toEqual([`${prefix}b`, `${prefix}a`]);
    },
  );
});
