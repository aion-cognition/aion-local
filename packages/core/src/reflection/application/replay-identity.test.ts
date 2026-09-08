import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { replayExperiences } from './replay.js';
import { ARCHIVE_SCHEMA_VERSION } from '../../infrastructure/sqlite/experience-archive.js';
import {
  freezeMigrationCohort,
  recordIngest,
} from '../../infrastructure/sqlite/migration-cohorts.js';
import {
  acceptReferenceBatch,
  listReferenceBatches,
  recordSourceParts,
  recordSourceRecord,
} from '../../infrastructure/sqlite/source-identity.js';
import {
  listEvidenceAcknowledgments,
  recordEvidenceAcknowledgment,
  SEMANTIC_PROCESSING_EFFECT,
  transitionSourceResidency,
} from '../../infrastructure/sqlite/source-lifecycle.js';
import {
  archiveExperience,
  closeReplaySubstrate,
  openReplaySubstrate,
  ARCHIVED_AT,
  IDENTITY,
  OCCURRED,
  WALL_NOW,
  type ReplaySubstrate,
  type RunCall,
} from '../test-support/replay-substrate.fixture.js';

let substrate: ReplaySubstrate;
let calls: RunCall[];

beforeEach(() => {
  substrate = openReplaySubstrate();
  ({ calls } = substrate);
});

afterEach(() => {
  closeReplaySubstrate(substrate);
});

function recordIdentity(index: number, archiveId: string, turnIds: readonly string[]): string {
  const sourceId = `archived-episode-${String(index)}`;
  recordSourceRecord(substrate.store.db, {
    sourceId,
    sessionId: IDENTITY,
    verificationStatus: 'verified',
    occurredAt: OCCURRED[index] ?? ARCHIVED_AT,
    createdAt: WALL_NOW,
    archive: {
      canonicalArchiveId: archiveId,
      archiveSchemaVersion: ARCHIVE_SCHEMA_VERSION,
      identityHash: `identity-${String(index)}`,
      verifiedContentDigest: `hash-${String(index)}`,
      verificationPolicyVersion: 1,
      archivedAt: ARCHIVED_AT,
    },
  });
  // The ingest position is what puts an occurrence in the live order a replay walks.
  recordIngest(substrate.store.db, sourceId, WALL_NOW);
  recordSourceParts(
    substrate.store.db,
    sourceId,
    turnIds.map((turnId, ordinal) => ({
      partKind: 'turn' as const,
      ordinal,
      turnId,
      contentHash: `turn-${String(ordinal)}`,
    })),
  );
  return sourceId;
}

describe('replay and residency', () => {
  it('skips an evicted source and names the path its projection comes back through', async () => {
    const sourceId = recordIdentity(0, archiveExperience(substrate, 0), ['turn-a']);
    transitionSourceResidency(substrate.store.db, {
      sourceId,
      state: 'evicted',
      operationId: 'operation-evict',
      transitionedAt: WALL_NOW,
    });

    const report = await replayExperiences(substrate.deps, { batchSize: 2, clock: () => WALL_NOW });

    expect(report).toMatchObject({ scanned: 1, replayed: 0, skippedEvicted: 1, failed: 0 });
    expect(calls).toEqual([]);
    expect(substrate.graph.statements).toHaveLength(0);
  });

  it('leaves what an evicted source owes exactly where the skip found it', async () => {
    const sourceId = recordIdentity(0, archiveExperience(substrate, 0), ['turn-a']);
    acceptReferenceBatch(substrate.store.db, {
      sourceId,
      acceptedHash: 'accepted-1',
      receivedAt: WALL_NOW,
      operationKey: 'delivery-1',
      introduced: ['node-1'],
    });
    recordEvidenceAcknowledgment(substrate.store.db, {
      sourceId,
      referenceVersion: 1,
      effectKind: SEMANTIC_PROCESSING_EFFECT,
      state: 'owed',
    });
    transitionSourceResidency(substrate.store.db, {
      sourceId,
      state: 'evicted',
      operationId: 'operation-evict',
      transitionedAt: WALL_NOW,
    });

    await replayExperiences(substrate.deps, { batchSize: 2, clock: () => WALL_NOW });

    expect(listEvidenceAcknowledgments(substrate.store.db, sourceId)).toEqual([
      {
        sourceId,
        referenceVersion: 1,
        effectKind: SEMANTIC_PROCESSING_EFFECT,
        state: 'owed',
        completedAt: null,
      },
    ]);
    expect(listReferenceBatches(substrate.store.db, sourceId)).toHaveLength(1);
  });

  it('projects a resident source under the ids its records already carry', async () => {
    const sourceId = recordIdentity(0, archiveExperience(substrate, 0), ['turn-a']);

    const report = await replayExperiences(substrate.deps, { batchSize: 2, clock: () => WALL_NOW });

    expect(report).toMatchObject({ scanned: 1, replayed: 1, skippedEvicted: 0 });
    expect(calls.map((call) => call.episodeId)).toEqual([sourceId]);
    expect(substrate.graph.nodesWithLabel('Turn').map((node) => node.id)).toEqual(['turn-a']);
  });

  it('refuses a source whose recorded parts disagree with the archived turns', async () => {
    recordIdentity(0, archiveExperience(substrate, 0), ['turn-a', 'turn-b']);

    const report = await replayExperiences(substrate.deps, { batchSize: 2, clock: () => WALL_NOW });

    expect(report).toMatchObject({ scanned: 1, replayed: 0, failed: 1 });
    expect(calls).toEqual([]);
  });
});

describe('replay and the frozen cohort', () => {
  /** A legacy source: recorded, in a frozen cohort, and never in the live ingest order. */
  function freezeLegacy(index: number, turnIds: readonly string[]): string {
    const sourceId = `archived-episode-${String(index)}`;
    recordSourceRecord(substrate.store.db, {
      sourceId,
      sessionId: IDENTITY,
      verificationStatus: 'verified',
      occurredAt: OCCURRED[index] ?? ARCHIVED_AT,
      createdAt: WALL_NOW,
      archive: {
        canonicalArchiveId: archiveExperience(substrate, index),
        archiveSchemaVersion: ARCHIVE_SCHEMA_VERSION,
        identityHash: `identity-${String(index)}`,
        verifiedContentDigest: `hash-${String(index)}`,
        verificationPolicyVersion: 1,
        archivedAt: ARCHIVED_AT,
      },
    });
    recordSourceParts(
      substrate.store.db,
      sourceId,
      turnIds.map((turnId, ordinal) => ({
        partKind: 'turn' as const,
        ordinal,
        turnId,
        contentHash: `turn-${String(ordinal)}`,
      })),
    );
    return sourceId;
  }

  function freeze(members: readonly string[]): void {
    freezeMigrationCohort(substrate.store.db, {
      cohortId: 'cohort-1',
      cohortDigest: 'digest',
      intakeWatermark: 0,
      archiveRowidLow: 0,
      archiveRowidHigh: 100,
      graphCensusDigest: 'census',
      orderingPolicyVersion: 1,
      createdAt: WALL_NOW,
      members: [...members],
    });
  }

  it('walks the frozen members the live ingest order cannot reach', async () => {
    const first = freezeLegacy(0, ['legacy-turn-a']);
    const second = freezeLegacy(1, ['legacy-turn-b']);
    freeze([first, second]);

    const report = await replayExperiences(substrate.deps, {
      batchSize: 10,
      clock: () => WALL_NOW,
    });

    expect(report).toMatchObject({ scanned: 2, replayed: 2, cohortMembers: 2, unrecorded: 0 });
    expect(calls.map((call) => call.episodeId).sort()).toEqual([first, second].sort());
    expect(report.cursor).toEqual({ kind: 'cohort', cohortId: 'cohort-1', sourceId: second });
  });

  it('resumes the frozen walk from the member it stopped on', async () => {
    const first = freezeLegacy(0, ['legacy-turn-a']);
    const second = freezeLegacy(1, ['legacy-turn-b']);
    freeze([first, second]);

    const stopped = await replayExperiences(substrate.deps, {
      batchSize: 1,
      limit: 1,
      clock: () => WALL_NOW,
    });

    expect(stopped).toMatchObject({ scanned: 1, cohortMembers: 1 });
    expect(stopped.cursor).toEqual({ kind: 'cohort', cohortId: 'cohort-1', sourceId: first });
    const seen = calls.map((call) => call.episodeId);

    const resumed = await replayExperiences(substrate.deps, {
      batchSize: 10,
      cursor: stopped.cursor,
      clock: () => WALL_NOW,
    });

    expect(resumed).toMatchObject({ scanned: 1, cohortMembers: 1 });
    expect(calls.map((call) => call.episodeId)).toEqual([...seen, second]);
  });

  it('leaves a member the live order already reached out of the frozen walk', async () => {
    const legacy = freezeLegacy(0, ['legacy-turn-a']);
    const live = recordIdentity(1, archiveExperience(substrate, 1), ['live-turn-a']);
    freeze([legacy, live]);

    const report = await replayExperiences(substrate.deps, {
      batchSize: 10,
      clock: () => WALL_NOW,
    });

    expect(report).toMatchObject({ scanned: 2, cohortMembers: 1 });
    expect(calls.map((call) => call.episodeId)).toEqual([live, legacy]);
  });
});
