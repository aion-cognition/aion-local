import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { replayExperiences } from './replay.js';
import { ARCHIVE_SCHEMA_VERSION } from '../../infrastructure/sqlite/experience-archive.js';
import { freezeMigrationCohort } from '../../infrastructure/sqlite/migration-cohorts.js';
import {
  recordSourceParts,
  recordSourceRecord,
} from '../../infrastructure/sqlite/source-identity.js';
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

describe('frozen selection boundary', () => {
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

  it('honors stale selection for frozen members just as it does for the live order', async () => {
    const source = freezeLegacy(0, ['original-turn']);
    freeze([source]);
    const report = await replayExperiences(substrate.deps, {
      selection: { stale: true },
      batchSize: 10,
      clock: () => WALL_NOW,
    });
    expect.soft(report.scanned).toBe(0);
    expect.soft(calls).toEqual([]);
  });
});
