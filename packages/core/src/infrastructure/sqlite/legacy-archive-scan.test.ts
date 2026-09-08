import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteStore } from './database.js';
import {
  ARCHIVE_SCHEMA_VERSION,
  insertExperience,
  type ExperienceArchiveInput,
} from './experience-archive.js';
import {
  archiveRowidBounds,
  deriveSourceRecordInput,
  groupArchiveRowsBySource,
  pageArchiveRows,
} from './legacy-archive-scan.js';
import {
  advanceCohortCursor,
  countMigrationProgress,
  freezeMigrationCohort,
  listIngestAfter,
  readIntakeWatermark,
  readMigrationCohort,
  readMigrationProgress,
  recordIngest,
  recordMigrationProgress,
} from './migration-cohorts.js';
import { readSourceRecord, recordSourceRecord } from './source-identity.js';

const NOW = new Date('2026-09-08T02:00:00.000Z');

function input(overrides: Partial<ExperienceArchiveInput> = {}): ExperienceArchiveInput {
  return {
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    pipelineVersion: 'v1',
    identity: 'agent-desktop-1',
    sessionId: 'session-1',
    episodeId: 'episode-1',
    contentHash: 'content-hash-1',
    occurredAt: '2026-01-01T00:00:00.000Z',
    archivedAt: '2026-01-01T00:05:00.000Z',
    payload: { turns: [{ role: 'user', text: 'hi' }] },
    ...overrides,
  };
}

describe('walking the frozen archive bounds', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-archive-scan-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('pages by the key so a restart resumes where it stopped', () => {
    for (const episodeId of ['episode-1', 'episode-2', 'episode-3', 'episode-4']) {
      insertExperience(store.db, input({ episodeId, contentHash: `hash-${episodeId}` }));
    }
    const bounds = archiveRowidBounds(store.db);
    expect(bounds.rows).toBe(4);

    const first = pageArchiveRows(store.db, { ...bounds, limit: 2 });
    const second = pageArchiveRows(store.db, {
      ...bounds,
      cursor: first.at(-1)?.rowid,
      limit: 2,
    });
    const third = pageArchiveRows(store.db, {
      ...bounds,
      cursor: second.at(-1)?.rowid,
      limit: 2,
    });

    expect([...first, ...second].map((row) => row.episodeId)).toEqual([
      'episode-1',
      'episode-2',
      'episode-3',
      'episode-4',
    ]);
    expect(third).toEqual([]);
  });

  it('leaves a row written after the freeze outside the bounds', () => {
    insertExperience(store.db, input({ episodeId: 'in-cohort' }));
    const bounds = archiveRowidBounds(store.db);
    insertExperience(store.db, input({ episodeId: 'after-freeze', contentHash: 'hash-late' }));

    expect(pageArchiveRows(store.db, { ...bounds, limit: 10 }).map((row) => row.episodeId)).toEqual(
      ['in-cohort'],
    );
  });

  it('reads several archive rows of one episode as one source with aliases', () => {
    insertExperience(
      store.db,
      input({ episodeId: 'episode-1', identity: 'a', archivedAt: '2026-01-01T00:05:00.000Z' }),
    );
    insertExperience(
      store.db,
      input({ episodeId: 'episode-1', identity: 'b', archivedAt: '2026-01-01T00:09:00.000Z' }),
    );
    const bounds = archiveRowidBounds(store.db);

    const [group] = groupArchiveRowsBySource(pageArchiveRows(store.db, { ...bounds, limit: 10 }));

    expect(group).toMatchObject({
      sourceId: 'episode-1',
      archivedAt: '2026-01-01T00:05:00.000Z',
      conflictingAliases: false,
    });
    expect(group?.aliasArchiveIds).toHaveLength(1);
  });

  it('groups the same way on a second pass over the same rows', () => {
    insertExperience(store.db, input({ episodeId: 'episode-1', identity: 'a' }));
    insertExperience(store.db, input({ episodeId: 'episode-1', identity: 'b' }));
    insertExperience(store.db, input({ episodeId: 'episode-2', contentHash: 'hash-2' }));
    const bounds = archiveRowidBounds(store.db);

    const first = groupArchiveRowsBySource(pageArchiveRows(store.db, { ...bounds, limit: 10 }));
    const second = groupArchiveRowsBySource(pageArchiveRows(store.db, { ...bounds, limit: 10 }));

    expect(second).toEqual(first);
  });

  it('pins a source whose archive rows disagree about its content', () => {
    insertExperience(store.db, input({ episodeId: 'episode-1', contentHash: 'hash-a' }));
    insertExperience(store.db, input({ episodeId: 'episode-1', contentHash: 'hash-b' }));
    const bounds = archiveRowidBounds(store.db);

    const [group] = groupArchiveRowsBySource(pageArchiveRows(store.db, { ...bounds, limit: 10 }));
    expect(group?.conflictingAliases).toBe(true);

    const derived = deriveSourceRecordInput(group!, NOW);
    expect(derived.verificationStatus).toBe('pinned');

    recordSourceRecord(store.db, derived);
    expect(readSourceRecord(store.db, 'episode-1')).toMatchObject({
      verificationStatus: 'pinned',
      canonicalArchiveId: null,
    });
  });

  it('never derives a verified status from the archive alone', () => {
    insertExperience(store.db, input({ episodeId: 'episode-1' }));
    const bounds = archiveRowidBounds(store.db);
    const [group] = groupArchiveRowsBySource(pageArchiveRows(store.db, { ...bounds, limit: 10 }));

    const derived = deriveSourceRecordInput(group!, NOW);

    expect(derived.verificationStatus).toBe('unresolved');
    expect(derived.captureOrderBasis).toBe('archive_acceptance');
  });
});

describe('the frozen migration cohort', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-cohort-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function freeze(members: readonly string[]): number {
    return freezeMigrationCohort(store.db, {
      cohortId: 'cohort-1',
      cohortDigest: 'digest-1',
      intakeWatermark: readIntakeWatermark(store.db),
      archiveRowidLow: 1,
      archiveRowidHigh: 100,
      graphCensusDigest: 'census-1',
      orderingPolicyVersion: 1,
      createdAt: NOW,
      members,
    });
  }

  it('writes every member before any verification pages, graph-only ones included', () => {
    expect(freeze(['archived-1', 'archived-2', 'graph-only-1'])).toBe(3);

    expect(countMigrationProgress(store.db, 'cohort-1')).toEqual({
      accounted: 3,
      verified: 0,
      pinned: 0,
    });
    expect(readMigrationProgress(store.db, 'cohort-1', 'graph-only-1')).toMatchObject({
      status: 'accounted',
    });
  });

  it('a second freeze of the same cohort adds nothing and keeps the progress made', () => {
    freeze(['archived-1', 'archived-2']);
    recordMigrationProgress(store.db, {
      cohortId: 'cohort-1',
      sourceId: 'archived-1',
      status: 'verified',
    });

    expect(freeze(['archived-1', 'archived-2'])).toBe(0);
    expect(readMigrationProgress(store.db, 'cohort-1', 'archived-1')?.status).toBe('verified');
  });

  it('refuses a repeat freeze that carries a different census', () => {
    freeze(['archived-1']);
    const before = readMigrationCohort(store.db, 'cohort-1');

    expect(() =>
      freezeMigrationCohort(store.db, {
        cohortId: 'cohort-1',
        cohortDigest: 'digest-2',
        intakeWatermark: 5,
        archiveRowidLow: 1,
        archiveRowidHigh: 200,
        graphCensusDigest: 'census-2',
        orderingPolicyVersion: 1,
        createdAt: NOW,
        members: ['archived-1', 'late-arrival'],
      }),
    ).toThrow(/already frozen under a different census/);

    expect(readMigrationCohort(store.db, 'cohort-1')).toEqual(before);
    expect(readMigrationProgress(store.db, 'cohort-1', 'late-arrival')).toBeUndefined();
    expect(countMigrationProgress(store.db, 'cohort-1')).toEqual({
      accounted: 1,
      verified: 0,
      pinned: 0,
    });
  });

  it('refuses a repeat freeze that keeps the header and changes the members', () => {
    freeze(['archived-1']);

    expect(() => freeze(['archived-1', 'late-arrival'])).toThrow(
      /already frozen over a different member set/,
    );
    expect(readMigrationProgress(store.db, 'cohort-1', 'late-arrival')).toBeUndefined();
  });

  it('the membership survives a close and reopen', () => {
    const path = join(dir, 'restart.sqlite');
    const first = new SqliteStore({ filePath: path });
    freezeMigrationCohort(first.db, {
      cohortId: 'cohort-1',
      cohortDigest: 'digest-1',
      intakeWatermark: 0,
      archiveRowidLow: 1,
      archiveRowidHigh: 100,
      graphCensusDigest: 'census-1',
      orderingPolicyVersion: 1,
      createdAt: NOW,
      members: ['graph-only-1'],
    });
    advanceCohortCursor(first.db, 'cohort-1', 42);
    first.close();

    const reopened = new SqliteStore({ filePath: path });
    try {
      expect(readMigrationCohort(reopened.db, 'cohort-1')?.scanCursor).toBe(42);
      expect(readMigrationProgress(reopened.db, 'cohort-1', 'graph-only-1')).toBeDefined();
    } finally {
      reopened.close();
    }
  });

  it('moves the scan cursor forward only', () => {
    freeze(['archived-1']);

    expect(advanceCohortCursor(store.db, 'cohort-1', 10)).toBe(true);
    expect(advanceCohortCursor(store.db, 'cohort-1', 5)).toBe(false);
    expect(readMigrationCohort(store.db, 'cohort-1')?.scanCursor).toBe(10);
  });

  it('refuses to move a source between chunks once its assignment is committed', () => {
    freeze(['archived-1']);
    recordMigrationProgress(store.db, {
      cohortId: 'cohort-1',
      sourceId: 'archived-1',
      status: 'verified',
      partitionAssignment: 'chunk-a',
    });

    expect(() => {
      recordMigrationProgress(store.db, {
        cohortId: 'cohort-1',
        sourceId: 'archived-1',
        status: 'verified',
        partitionAssignment: 'chunk-b',
      });
    }).toThrow(/already assigned to chunk-a/);

    // A later pass that improves the evidence and says nothing about the chunk is fine.
    recordMigrationProgress(store.db, {
      cohortId: 'cohort-1',
      sourceId: 'archived-1',
      status: 'verified',
      reason: 'better clock proof recorded',
    });
    expect(readMigrationProgress(store.db, 'cohort-1', 'archived-1')).toMatchObject({
      partitionAssignment: 'chunk-a',
      reason: 'better clock proof recorded',
    });
  });

  it('a source that arrives after the freeze appears once in the tail', () => {
    recordIngest(store.db, 'before-1', NOW);
    freeze(['before-1']);
    const watermark = readIntakeWatermark(store.db);

    recordIngest(store.db, 'after-1', NOW);
    // The same arrival stated twice keeps its position rather than taking a second one.
    recordIngest(store.db, 'after-1', NOW);

    expect(listIngestAfter(store.db, watermark, 10).map((row) => row.sourceId)).toEqual([
      'after-1',
    ]);
    expect(readMigrationProgress(store.db, 'cohort-1', 'after-1')).toBeUndefined();
  });

  it('a source carrying an old clock still lands once in the tail behind the watermark', () => {
    freeze([]);
    const watermark = readIntakeWatermark(store.db);
    insertExperience(
      store.db,
      input({
        episodeId: 'backdated-1',
        contentHash: 'hash-backdated',
        occurredAt: '2024-03-01T00:00:00.000Z',
        archivedAt: '2026-09-08T02:10:00.000Z',
      }),
    );
    recordIngest(store.db, 'backdated-1', NOW);

    expect(listIngestAfter(store.db, watermark, 10).map((row) => row.sourceId)).toEqual([
      'backdated-1',
    ]);

    recordMigrationProgress(store.db, {
      cohortId: 'cohort-1',
      sourceId: 'backdated-1',
      status: 'verified',
      partitionAssignment: 'chunk-tail',
    });
    expect(countMigrationProgress(store.db, 'cohort-1')).toEqual({
      accounted: 0,
      verified: 1,
      pinned: 0,
    });
  });
});

describe('running a backfill batch twice', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-backfill-batch-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
    // Two archive rows for one episode, a second episode, and a member the archive never held.
    insertExperience(store.db, input({ episodeId: 'episode-1', identity: 'a' }));
    insertExperience(store.db, input({ episodeId: 'episode-1', identity: 'b' }));
    insertExperience(store.db, input({ episodeId: 'episode-2', contentHash: 'hash-2' }));
    const bounds = archiveRowidBounds(store.db);
    freezeMigrationCohort(store.db, {
      cohortId: 'cohort-1',
      cohortDigest: 'digest-1',
      intakeWatermark: readIntakeWatermark(store.db),
      archiveRowidLow: bounds.low,
      archiveRowidHigh: bounds.high,
      graphCensusDigest: 'census-1',
      orderingPolicyVersion: 1,
      createdAt: NOW,
      members: ['episode-1', 'episode-2', 'graph-only-1'],
    });
    recordSourceRecord(store.db, {
      sourceId: 'graph-only-1',
      sessionId: 'session-1',
      verificationStatus: 'pinned',
      verificationReason: 'the archive holds no row for this episode',
      occurredAt: '2026-01-01T00:00:00.000Z',
      createdAt: NOW,
    });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function runBatch(): void {
    const cohort = readMigrationCohort(store.db, 'cohort-1');
    if (cohort === undefined) {
      throw new Error('the cohort was not frozen');
    }
    const rows = pageArchiveRows(store.db, {
      low: cohort.archiveRowidLow,
      high: cohort.archiveRowidHigh,
      limit: 100,
    });
    for (const group of groupArchiveRowsBySource(rows)) {
      recordSourceRecord(store.db, deriveSourceRecordInput(group, NOW));
      recordMigrationProgress(store.db, {
        cohortId: 'cohort-1',
        sourceId: group.sourceId,
        status: group.conflictingAliases ? 'pinned' : 'accounted',
      });
    }
    const last = rows.at(-1);
    if (last !== undefined) {
      advanceCohortCursor(store.db, 'cohort-1', last.rowid);
    }
  }

  function snapshot(): unknown {
    return {
      sources: store.db.prepare('SELECT * FROM source_records ORDER BY source_id').all(),
      progress: store.db.prepare('SELECT * FROM migration_progress ORDER BY source_id').all(),
      cohort: store.db.prepare('SELECT * FROM migration_cohorts').all(),
    };
  }

  it('changes nothing the second time through', () => {
    runBatch();
    const afterFirst = snapshot();

    runBatch();

    expect(snapshot()).toEqual(afterFirst);
  });

  it('leaves the pinned member the batch never reached exactly as it was', () => {
    runBatch();
    runBatch();

    expect(readSourceRecord(store.db, 'graph-only-1')).toMatchObject({
      verificationStatus: 'pinned',
      canonicalArchiveId: null,
      archivedAt: null,
    });
    expect(readMigrationProgress(store.db, 'cohort-1', 'graph-only-1')?.status).toBe('accounted');
  });
});
