import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteStore } from './database.js';
import { insertExperience } from './experience-archive.js';
import {
  activateProcessingGeneration,
  allocateProcessingGeneration,
  completeSourceWork,
  prepareInventorySkeleton,
  stageWorkId,
} from './processing-generations.js';
import { publishReadinessPolicy } from './readiness-policies.js';
import { recordSourceRecord } from './source-identity.js';
import { recordSourceStateVersion } from './source-lifecycle.js';
import { sessionObligationCensus } from './source-readiness.js';

const NOW = new Date('2026-09-08T02:00:00.000Z');
const SESSION = 'session-1';
const STAGES = ['entities', 'cognitive'];

describe('session obligation census', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-readiness-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
    publishReadinessPolicy(
      store.db,
      { pipelineVersion: 'v1', stageNames: STAGES, transferCapabilities: [] },
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

  function settleEveryStage(sourceId: string, generation: number): void {
    for (const name of STAGES) {
      completeSourceWork(
        store.db,
        stageWorkId(sourceId, generation, name),
        { outcome: 'complete', reason: 'accepted_pass_applied' },
        NOW,
      );
    }
  }

  it('reports an unknown count when a required stage inventory is absent', () => {
    const generation = liveSource('source');
    settleEveryStage('source', generation);
    store.db
      .prepare("DELETE FROM source_work WHERE source_id='source' AND stage_name='cognitive'")
      .run();
    expect(sessionObligationCensus(store.db, SESSION).status).toBe('unavailable');
  });
  it('does not accept a timestamp as acknowledgment of a source-state version', () => {
    liveSource('source');
    recordSourceStateVersion(store.db, {
      sourceId: 'source',
      stateKind: 'forgotten',
      operationId: 'never-acknowledged',
      knownFrom: NOW,
      observedAt: NOW,
    });
    expect(sessionObligationCensus(store.db, SESSION)).toMatchObject({
      status: 'measured',
      sourcesOwingWork: 1,
    });
  });
});
