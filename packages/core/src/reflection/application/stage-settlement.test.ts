import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { recordStageSettlements } from './stage-settlement.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import {
  activateProcessingGeneration,
  allocateProcessingGeneration,
  prepareInventorySkeleton,
  readGeneration,
} from '../../infrastructure/sqlite/processing-generations.js';
import { publishReadinessPolicy } from '../../infrastructure/sqlite/readiness-policies.js';
import { recordSourceStateVersion } from '../../infrastructure/sqlite/source-lifecycle.js';
import { readGenerationWork } from '../../infrastructure/sqlite/source-readiness.js';
import {
  STAGE_ALREADY_APPLIED_SUMMARY,
  type ReflectionSummary,
  type StageRecord,
} from '../domain/stage.js';

const NOW = new Date('2026-09-08T02:00:00.000Z');
const SOURCE = 'source-1';
const STAGES = ['entities', 'cognitive', 'supersession'];

function record(name: string, overrides: Partial<StageRecord> = {}): StageRecord {
  return { name, status: 'ok', summary: 'did the thing', durationMs: 1, ...overrides };
}

function summary(stages: readonly StageRecord[]): ReflectionSummary {
  return { episodeId: SOURCE, durationMs: 1, stages: [...stages], counts: {}, skippedStages: [] };
}

describe('stage settlement', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-stage-settlement-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
    publishReadinessPolicy(
      store.db,
      { pipelineVersion: 'v1', stageNames: STAGES, transferCapabilities: [] },
      NOW,
    );
    const generation = allocateProcessingGeneration(store.db, {
      sourceId: SOURCE,
      policyRevision: 1,
      createdAt: NOW,
    });
    prepareInventorySkeleton(store.db, {
      sourceId: SOURCE,
      processingGeneration: generation,
      stageNames: STAGES,
      dueAt: NOW,
    });
    activateProcessingGeneration(store.db, SOURCE, generation);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function stateOf(stageName: string): { state: string; reason: string | null; outcome?: string } {
    const row = readGenerationWork(store.db, SOURCE, 1).find(
      (entry) => entry.stageName === stageName,
    );
    return {
      state: row?.state ?? 'missing',
      reason: row?.reason ?? null,
      ...(row?.outcome === undefined ? {} : { outcome: row.outcome.reason }),
    };
  }

  it('closes a stage that ran its accepted pass', () => {
    const report = recordStageSettlements(store.db, SOURCE, summary([record('entities')]), NOW);

    expect(report.settled).toEqual(['entities']);
    expect(stateOf('entities')).toMatchObject({
      state: 'completed',
      outcome: 'accepted_pass_applied',
    });
  });

  it('closes a stage that declared a typed reason for having no work', () => {
    recordStageSettlements(
      store.db,
      SOURCE,
      summary([
        record('entities', {
          status: 'skipped',
          summary: 'no text',
          settled: { disposition: 'not_applicable', reason: 'below_minimum_input' },
        }),
      ]),
      NOW,
    );

    expect(stateOf('entities')).toMatchObject({
      state: 'completed',
      outcome: 'below_minimum_input',
    });
  });

  it('leaves an untyped skip owed and records what it said', () => {
    const report = recordStageSettlements(
      store.db,
      SOURCE,
      summary([record('entities', { status: 'skipped', summary: 'vectors not ready yet' })]),
      NOW,
    );

    expect(report.settled).toEqual([]);
    expect(report.owed).toEqual(['entities']);
    expect(stateOf('entities')).toMatchObject({
      state: 'pending',
      reason: 'skipped: vectors not ready yet',
    });
  });

  it('leaves a failed stage owed', () => {
    recordStageSettlements(
      store.db,
      SOURCE,
      summary([record('entities', { status: 'failed', summary: 'model timed out' })]),
      NOW,
    );

    expect(stateOf('entities')).toMatchObject({ state: 'pending' });
  });

  it('holds an empty reading owed while the stage ahead of it is still owed', () => {
    recordStageSettlements(
      store.db,
      SOURCE,
      summary([
        record('entities', { status: 'failed', summary: 'model timed out' }),
        record('cognitive', {
          status: 'skipped',
          summary: 'nothing to work on',
          retryable: true,
          settledOnUpstream: { disposition: 'not_applicable', reason: 'proved_empty_input' },
        }),
      ]),
      NOW,
    );

    expect(stateOf('cognitive')).toMatchObject({
      state: 'pending',
      reason: 'waiting on an earlier stage: proved_empty_input',
    });
  });

  it('settles an empty reading once every stage ahead of it has closed', () => {
    recordStageSettlements(
      store.db,
      SOURCE,
      summary([
        record('entities'),
        record('cognitive', {
          status: 'skipped',
          summary: 'nothing to work on',
          retryable: true,
          settledOnUpstream: { disposition: 'not_applicable', reason: 'proved_empty_input' },
        }),
      ]),
      NOW,
    );

    expect(stateOf('cognitive')).toMatchObject({
      state: 'completed',
      outcome: 'proved_empty_input',
    });
  });

  it('leaves a row a previous run already settled alone', () => {
    recordStageSettlements(store.db, SOURCE, summary([record('entities')]), NOW);
    const report = recordStageSettlements(
      store.db,
      SOURCE,
      summary([record('entities', { status: 'skipped', summary: STAGE_ALREADY_APPLIED_SUMMARY })]),
      NOW,
    );

    expect(report.settled).toEqual([]);
    expect(report.owed).toEqual([]);
    expect(stateOf('entities')).toMatchObject({ state: 'completed' });
  });

  it('closes the inventory only once every required stage carries an outcome', () => {
    const partial = recordStageSettlements(store.db, SOURCE, summary([record('entities')]), NOW);
    expect(partial.inventoryComplete).toBe(false);
    expect(partial.unrecorded).toEqual([]);
    expect(readGeneration(store.db, SOURCE, 1)?.inventoryComplete).toBe(false);

    const full = recordStageSettlements(
      store.db,
      SOURCE,
      summary([record('cognitive'), record('supersession')]),
      NOW,
    );
    expect(full.inventoryComplete).toBe(true);
    expect(readGeneration(store.db, SOURCE, 1)?.inventoryComplete).toBe(true);
  });

  it('closes a forgotten source stage rows as not applicable, naming the statement', () => {
    recordSourceStateVersion(store.db, {
      sourceId: SOURCE,
      stateKind: 'forgotten',
      operationId: 'forget-1',
      knownFrom: NOW,
      observedAt: NOW,
    });

    recordStageSettlements(store.db, SOURCE, summary([]), NOW);

    for (const name of STAGES) {
      expect(stateOf(name)).toMatchObject({ state: 'completed', outcome: 'source_forgotten' });
    }
    expect(
      readGenerationWork(store.db, SOURCE, 1).find((row) => row.stageName === 'entities')?.outcome
        ?.proof,
    ).toMatchObject({ stateVersion: 1 });
  });

  it('owes those rows again once the forget they rested on is withdrawn', () => {
    recordSourceStateVersion(store.db, {
      sourceId: SOURCE,
      stateKind: 'forgotten',
      operationId: 'forget-1',
      knownFrom: NOW,
      observedAt: NOW,
    });
    recordStageSettlements(store.db, SOURCE, summary([]), NOW);
    recordSourceStateVersion(store.db, {
      sourceId: SOURCE,
      stateKind: 'unforgotten',
      operationId: 'unforget-1',
      knownFrom: NOW,
      observedAt: NOW,
    });

    recordStageSettlements(store.db, SOURCE, summary([]), NOW);

    expect(readGenerationWork(store.db, SOURCE, 1).map((row) => row.state)).toEqual([
      'pending',
      'pending',
      'pending',
    ]);
  });

  it('leaves a pass this run closed alone when the source is forgotten', () => {
    recordStageSettlements(store.db, SOURCE, summary([record('entities')]), NOW);
    recordSourceStateVersion(store.db, {
      sourceId: SOURCE,
      stateKind: 'forgotten',
      operationId: 'forget-1',
      knownFrom: NOW,
      observedAt: NOW,
    });

    recordStageSettlements(store.db, SOURCE, summary([]), NOW);

    expect(stateOf('entities')).toMatchObject({ outcome: 'accepted_pass_applied' });
    expect(stateOf('cognitive')).toMatchObject({ outcome: 'source_forgotten' });
  });

  it('decides nothing while a statement about the source is unacknowledged', () => {
    recordSourceStateVersion(store.db, {
      sourceId: SOURCE,
      stateKind: 'forgotten',
      operationId: 'forget-1',
      observedAt: NOW,
    });

    recordStageSettlements(store.db, SOURCE, summary([]), NOW);

    expect(stateOf('entities')).toMatchObject({ state: 'pending' });
  });

  it('records nothing for a source with no active generation', () => {
    const report = recordStageSettlements(
      store.db,
      'unknown-source',
      summary([record('entities')]),
      NOW,
    );

    expect(report).toEqual({ settled: [], owed: [], unrecorded: [], inventoryComplete: false });
  });
});
