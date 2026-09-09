import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteStore } from './database.js';
import { insertExperience } from './experience-archive.js';
import { replaceProcessingGeneration } from './generation-lifecycle.js';
import {
  activateProcessingGeneration,
  allocateProcessingGeneration,
  completeSourceWork,
  prepareGenerationWork,
  prepareInventorySkeleton,
  readActiveGeneration,
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

  it('checks required stage names instead of accepting an equal number of unrelated rows', () => {
    const generation = liveSource('source');
    settleEveryStage('source', generation);
    store.db
      .prepare("DELETE FROM source_work WHERE source_id='source' AND stage_name='supersession'")
      .run();
    prepareInventorySkeleton(store.db, {
      sourceId: 'source',
      processingGeneration: generation,
      stageNames: ['unrelated'],
      dueAt: NOW,
    });
    completeSourceWork(
      store.db,
      stageWorkId('source', generation, 'unrelated'),
      { outcome: 'complete', reason: 'accepted_pass_applied' },
      NOW,
    );
    expect(processingReadinessOf(store.db, 'source').completeness).toBe('unknown');
    expect(sessionObligationCensus(store.db, SESSION).status).toBe('unavailable');
  });

  it('keeps conflicting carried work visible to active readiness after a replacement', () => {
    const first = liveSource('source');
    prepareGenerationWork(store.db, {
      workId: 'old',
      sourceId: 'source',
      processingGeneration: first,
      kind: 'settlement',
      workKey: 'reference:1',
      dueAt: NOW,
    });
    store.db
      .prepare("UPDATE source_work SET continuation_json=? WHERE work_id='old'")
      .run('{"after":"old-position"}');
    const second = allocateProcessingGeneration(store.db, {
      sourceId: 'source',
      policyRevision: 1,
      createdAt: NOW,
    });
    prepareInventorySkeleton(store.db, {
      sourceId: 'source',
      processingGeneration: second,
      stageNames: STAGES,
      dueAt: NOW,
    });
    prepareGenerationWork(store.db, {
      workId: 'new',
      sourceId: 'source',
      processingGeneration: second,
      kind: 'settlement',
      workKey: 'reference:1',
      dueAt: NOW,
    });
    store.db
      .prepare("UPDATE source_work SET continuation_json=? WHERE work_id='new'")
      .run('{"after":"different-position"}');
    replaceProcessingGeneration(store.db, { sourceId: 'source', replacementGeneration: second });
    expect(store.db.prepare("SELECT state FROM source_work WHERE work_id='old'").get()).toEqual({
      state: 'pinned',
    });
    settleEveryStage('source', second);
    completeSourceWork(store.db, 'new', { outcome: 'complete', reason: 'settled' }, NOW);
    expect.soft(processingReadinessOf(store.db, 'source').completeness).not.toBe('complete');
    expect(sessionObligationCensus(store.db, SESSION)).toMatchObject({ sourcesOwingWork: 1 });
  });

  it('advances readiness when a withheld continuation is recorded', () => {
    liveSource('source');
    const before = readActiveGeneration(store.db, 'source')!.operationalRevision;
    recordStageSettlements(
      store.db,
      'source',
      {
        episodeId: 'source',
        durationMs: 0,
        counts: {},
        skippedStages: [],
        stages: [
          {
            name: 'entities',
            status: 'ok',
            summary: 'partial',
            durationMs: 0,
            withheldWork: [
              {
                nodeIds: ['a', 'b'],
                addresses: [{ kind: 'id', id: 'source' }],
                disposition: 'blocked',
                reason: 'required_source_suppressed',
                revision: buildEvidenceRevision([]),
              },
            ],
          },
        ],
      },
      NOW,
    );
    const continuation = store.db
      .prepare(
        "SELECT continuation_json FROM source_work WHERE source_id='source' AND stage_name='entities'",
      )
      .get() as { continuation_json: string | null };
    expect(continuation.continuation_json).not.toBeNull();
    expect(readActiveGeneration(store.db, 'source')!.operationalRevision).toBeGreaterThan(before);
  });

  it('accounts a required pass with retained transferred work without calling processing complete', () => {
    liveSource('source');
    completeSourceWork(
      store.db,
      stageWorkId('source', 1, 'entities'),
      { outcome: 'complete', reason: 'accepted_pass_applied' },
      NOW,
    );
    store.db
      .prepare(
        "UPDATE source_work SET state='transferred', capability_revision=1, input_revision_json=?, continuation_json=? WHERE source_id='source' AND stage_name='supersession'",
      )
      .run(
        JSON.stringify(buildEvidenceRevision([])),
        '{"runner":"supersession","runnerRevision":1,"addresses":[{"kind":"id","id":"source"}],"after":"pair-1","idempotencyKey":"source:1:supersession"}',
      );
    const answer = recordStageSettlements(
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
    expect.soft(processingReadinessOf(store.db, 'source').completeness).toBe('incomplete');
    expect(answer.inventoryComplete).toBe(true);
  });
  it('preserves retained-endpoint consistency work when applying a source forget', () => {
    liveSource('source');
    prepareInventorySkeleton(store.db, {
      sourceId: 'source',
      processingGeneration: 1,
      stageNames: ['context-vectors'],
      dueAt: NOW,
    });
    store.db
      .prepare(
        "UPDATE source_work SET continuation_json=? WHERE source_id='source' AND stage_name='context-vectors'",
      )
      .run('{"affectedIds":["retained-claim"],"effect":"retained_endpoint_vector"}');
    commitSourceState(store.db, {
      sourceId: 'source',
      stateKind: 'forgotten',
      operationId: 'forget-case',
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
    expect(
      store.db
        .prepare(
          "SELECT state FROM source_work WHERE source_id='source' AND stage_name='context-vectors'",
        )
        .get(),
    ).not.toEqual({ state: 'completed' });
  });
});
