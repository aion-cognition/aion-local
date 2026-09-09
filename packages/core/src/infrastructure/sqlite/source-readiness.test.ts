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
import {
  readGenerationWork,
  readPolicyStages,
  sessionObligationCensus,
} from './source-readiness.js';

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

  it('refuses a count for a session whose archived experiences have no source record', () => {
    archiveRow('source-1');

    expect(sessionObligationCensus(store.db, SESSION)).toMatchObject({
      status: 'unavailable',
      reason: 'unbackfilled',
    });
  });

  it('refuses a count for a session holding a source with no active generation', () => {
    archiveRow('source-1');
    sourceRow('source-1');

    expect(sessionObligationCensus(store.db, SESSION)).toMatchObject({
      status: 'unavailable',
      reason: 'missing_generation',
    });
  });

  it('refuses a count while a source still owes its inventory', () => {
    archiveRow('source-1');
    sourceRow('source-1');
    const generation = allocateProcessingGeneration(store.db, {
      sourceId: 'source-1',
      policyRevision: 0,
      createdAt: NOW,
    });
    store.db
      .prepare(
        `INSERT INTO source_work
           (work_id, source_id, processing_generation, kind, work_key, state, due_at)
         VALUES (?, 'source-1', ?, 'inventory', 'inventory:pending_policy', 'pending', ?)`,
      )
      .run('inventory:source-1', generation, NOW.toISOString());
    activateProcessingGeneration(store.db, 'source-1', generation);

    expect(sessionObligationCensus(store.db, SESSION)).toMatchObject({
      status: 'unavailable',
      reason: 'inventory_obligation',
    });
  });

  it('counts a source once however many obligations it holds', () => {
    liveSource('source-1');

    expect(sessionObligationCensus(store.db, SESSION)).toEqual({
      status: 'measured',
      sources: 1,
      sourcesOwingWork: 1,
      pendingJudgments: 0,
    });
  });

  it('counts a session whose sources have all settled as owing nothing', () => {
    const generation = liveSource('source-1');
    settleEveryStage('source-1', generation);

    expect(sessionObligationCensus(store.db, SESSION)).toEqual({
      status: 'measured',
      sources: 1,
      sourcesOwingWork: 0,
      pendingJudgments: 0,
    });
  });

  it('counts a source whose graph projection is gone exactly as a resident one', () => {
    liveSource('source-1');
    // Eviction removes the projection and leaves the records, which is the population counted.
    expect(sessionObligationCensus(store.db, SESSION)).toMatchObject({ sourcesOwingWork: 1 });
  });

  it('refuses a count for a generation naming a policy revision this store cannot read', () => {
    archiveRow('source-1');
    sourceRow('source-1');
    const generation = allocateProcessingGeneration(store.db, {
      sourceId: 'source-1',
      policyRevision: 99,
      createdAt: NOW,
    });
    prepareInventorySkeleton(store.db, {
      sourceId: 'source-1',
      processingGeneration: generation,
      stageNames: STAGES,
      dueAt: NOW,
    });
    activateProcessingGeneration(store.db, 'source-1', generation);

    expect(sessionObligationCensus(store.db, SESSION)).toMatchObject({
      status: 'unavailable',
      reason: 'unreadable_policy',
    });
  });

  it('drops a forgotten source stage work from the count and keeps its other obligations', () => {
    const generation = liveSource('source-1');
    // The forget is a disposition on the rows, not a filter over them: the settlement closes each
    // generative stage with its typed outcome, and the count reads what the rows say.
    for (const name of STAGES) {
      completeSourceWork(
        store.db,
        stageWorkId('source-1', generation, name),
        { outcome: 'not_applicable', reason: 'source_forgotten', proof: { stateVersion: 1 } },
        NOW,
      );
    }

    expect(sessionObligationCensus(store.db, SESSION)).toMatchObject({ sourcesOwingWork: 0 });

    store.db
      .prepare(
        `INSERT INTO source_work
           (work_id, source_id, processing_generation, kind, work_key, state, due_at)
         VALUES ('index:source-1', 'source-1', ?, 'index', 'source_index', 'pending', ?)`,
      )
      .run(generation, NOW.toISOString());

    expect(sessionObligationCensus(store.db, SESSION)).toMatchObject({ sourcesOwingWork: 1 });
  });

  it('keeps optional judgment work out of the required-processing count', () => {
    const generation = liveSource('source-1');
    settleEveryStage('source-1', generation);
    store.db
      .prepare(
        `INSERT INTO source_work
           (work_id, source_id, processing_generation, kind, work_key, state, due_at)
         VALUES ('judgment:source-1', 'source-1', ?, 'judgment', 'pair-1', 'pending', ?)`,
      )
      .run(generation, NOW.toISOString());

    expect(sessionObligationCensus(store.db, SESSION)).toEqual({
      status: 'measured',
      sources: 1,
      sourcesOwingWork: 0,
      pendingJudgments: 1,
    });
  });

  it('counts only the asked-for session', () => {
    liveSource('source-1');
    liveSource('source-2', 'session-2');

    expect(sessionObligationCensus(store.db, SESSION)).toMatchObject({ sources: 1 });
  });

  it('reads back the stage set a policy revision required', () => {
    expect(readPolicyStages(store.db, 1)).toEqual(STAGES);
    expect(readPolicyStages(store.db, 2)).toBeUndefined();
  });

  it('reads every obligation a generation holds with its typed outcome', () => {
    const generation = liveSource('source-1');
    completeSourceWork(
      store.db,
      stageWorkId('source-1', generation, 'entities'),
      { outcome: 'not_applicable', reason: 'below_minimum_input', proof: { textChars: 0 } },
      NOW,
    );

    const work = readGenerationWork(store.db, 'source-1', generation);
    expect(work).toHaveLength(2);
    expect(work[0]).toMatchObject({
      stageName: 'cognitive',
      state: 'pending',
      outcome: undefined,
    });
    expect(work[1]).toMatchObject({
      stageName: 'entities',
      state: 'completed',
      outcome: { outcome: 'not_applicable', reason: 'below_minimum_input' },
    });
  });
});
