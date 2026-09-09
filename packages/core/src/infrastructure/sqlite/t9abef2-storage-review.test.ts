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
import { sessionObligationCensus } from './source-readiness.js';
import { commitSourceState } from '../../evidence/test-support/evidence.fixture.js';
import { processingReadinessOf } from '../../reflection/application/readiness.js';
import { recordStageSettlements } from '../../reflection/application/stage-settlement.js';
import { buildEvidenceRevision } from '../publication/preconditions.js';

const NOW = new Date('2026-09-08T02:00:00.000Z');
const SESSION = 'session-1';
const STAGES = ['entities', 'supersession'];

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

  it('does not count an obsolete required-stage row as accounted inventory', () => {
    liveSource('source');
    settleEveryStage('source', 1);
    store.db
      .prepare(
        "UPDATE source_work SET state='obsolete' WHERE source_id='source' AND stage_name='supersession'",
      )
      .run();
    expect(processingReadinessOf(store.db, 'source').completeness).toBe('unknown');
    expect(sessionObligationCensus(store.db, SESSION).status).toBe('unavailable');
  });
  it.each([
    ['invalid evidence JSON', 'not-json', [{ kind: 'id', id: 'source' }], 1],
    ['invalid source address', JSON.stringify(buildEvidenceRevision([])), [null], 1],
    [
      'unregistered runner revision',
      JSON.stringify(buildEvidenceRevision([])),
      [{ kind: 'id', id: 'source' }],
      999,
    ],
  ])('does not account a transfer with %s', (_name, proof, addresses, runnerRevision) => {
    liveSource('source');
    completeSourceWork(
      store.db,
      stageWorkId('source', 1, 'entities'),
      { outcome: 'complete', reason: 'accepted_pass_applied' },
      NOW,
    );
    store.db
      .prepare(
        "UPDATE source_work SET state='transferred',capability_revision=1,input_revision_json=?,continuation_json=? WHERE source_id='source' AND stage_name='supersession'",
      )
      .run(
        proof,
        JSON.stringify({
          runner: 'supersession',
          runnerRevision,
          addresses,
          after: 'pair',
          idempotencyKey: 'source-pair',
        }),
      );
    const result = recordStageSettlements(
      store.db,
      'source',
      { episodeId: 'source', durationMs: 0, counts: {}, skippedStages: [], stages: [] },
      NOW,
    );
    expect(result.inventoryComplete).toBe(false);
  });
  it('does not assume undeclared retained-node work became generative on source forget', () => {
    liveSource('source');
    prepareInventorySkeleton(store.db, {
      sourceId: 'source',
      processingGeneration: 1,
      stageNames: ['context-vectors'],
      dueAt: NOW,
    });
    commitSourceState(store.db, {
      sourceId: 'source',
      stateKind: 'forgotten',
      operationId: 'forget',
      at: NOW,
    });
    recordStageSettlements(
      store.db,
      'source',
      { episodeId: 'source', durationMs: 0, counts: {}, skippedStages: [], stages: [] },
      NOW,
    );
    expect(
      store.db
        .prepare(
          "SELECT state FROM source_work WHERE source_id='source' AND stage_name='context-vectors'",
        )
        .get(),
    ).not.toEqual({ state: 'completed' });
  });
});
