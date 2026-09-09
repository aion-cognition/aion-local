import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteStore } from './database.js';
import { insertExperience } from './experience-archive.js';
import {
  activateProcessingGeneration,
  allocateProcessingGeneration,
  prepareInventorySkeleton,
} from './processing-generations.js';
import { publishReadinessPolicy } from './readiness-policies.js';
import { recordSourceRecord } from './source-identity.js';
import { commitSourceState } from '../../evidence/test-support/evidence.fixture.js';
import { recordStageSettlements } from '../../reflection/application/stage-settlement.js';

const NOW = new Date('2026-09-08T02:00:00.000Z');
const SESSION = 'session-1';
const STAGES = ['entities', 'supersession', 'context-vectors'];

describe('session obligation census', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-readiness-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
    publishReadinessPolicy(
      store.db,
      { pipelineVersion: 'v1', stageNames: STAGES, transferCapabilities: ['supersession'] },
      NOW,
    );
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function archiveRow(sourceId: string, sessionId = SESSION): void {
    insertExperience(store.db, {
      schemaVersion: 1,
      pipelineVersion: 'v1',
      identity: sessionId,
      sessionId,
      episodeId: sourceId,
      contentHash: `hash-${sourceId}`,
      occurredAt: NOW.toISOString(),
      archivedAt: NOW.toISOString(),
      payload: { turns: [] },
    });
  }

  function sourceRow(sourceId: string, sessionId = SESSION): void {
    recordSourceRecord(store.db, {
      sourceId,
      sessionId,
      verificationStatus: 'verified',
      occurredAt: NOW.toISOString(),
      createdAt: NOW,
      archive: {
        canonicalArchiveId: `archive-${sourceId}`,
        archiveSchemaVersion: 1,
        identityHash: `identity-${sourceId}`,
        verifiedContentDigest: `hash-${sourceId}`,
        verificationPolicyVersion: 1,
        archivedAt: NOW.toISOString(),
      },
    });
  }

  /** A source with its skeleton written and its generation live, as intake leaves one. */
  function liveSource(sourceId: string, sessionId = SESSION): number {
    archiveRow(sourceId, sessionId);
    sourceRow(sourceId, sessionId);
    const generation = allocateProcessingGeneration(store.db, {
      sourceId,
      policyRevision: 1,
      createdAt: NOW,
    });
    prepareInventorySkeleton(store.db, {
      sourceId,
      processingGeneration: generation,
      stageNames: STAGES,
      dueAt: NOW,
    });
    activateProcessingGeneration(store.db, sourceId, generation);
    return generation;
  }

  it.each([null, '{"effect":"unknown_consistency"}'])(
    'preserves policy-required retained-node work with declaration %s on forget',
    (continuation) => {
      liveSource('source');
      store.db
        .prepare("UPDATE source_work SET continuation_json=? WHERE stage_name='context-vectors'")
        .run(continuation);
      commitSourceState(store.db, {
        sourceId: 'source',
        stateKind: 'forgotten',
        operationId: 'forget',
        at: NOW,
      });
      recordStageSettlements(
        store.db,
        'source',
        {
          episodeId: 'source',
          durationMs: 0,
          counts: {},
          skippedStages: [],
          stages: [],
        },
        NOW,
      );
      expect
        .soft(
          store.db
            .prepare(
              "SELECT state FROM source_work WHERE source_id='source' AND stage_name='context-vectors'",
            )
            .get(),
        )
        .not.toEqual({ state: 'completed' });
      expect(
        store.db
          .prepare(
            "SELECT state FROM source_work WHERE source_id='source' AND stage_name='entities'",
          )
          .get(),
      ).toEqual({ state: 'completed' });
    },
  );
});
