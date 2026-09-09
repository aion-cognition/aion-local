import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { reflectionCompletionPublication, completionStages } from './completion-publication.js';
import { reflectionStages } from './pipeline.js';
import { readinessContractOf } from './readiness.js';
import { recordStageSettlements } from './stage-settlement.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { buildEvidenceRevision } from '../../infrastructure/publication/preconditions.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import {
  activateProcessingGeneration,
  allocateProcessingGeneration,
  prepareInventorySkeleton,
} from '../../infrastructure/sqlite/processing-generations.js';
import {
  readCurrentReadinessPolicy,
  publishReadinessPolicy,
} from '../../infrastructure/sqlite/readiness-policies.js';
import { readGenerationWork } from '../../infrastructure/sqlite/source-readiness.js';
import {
  stageSettlementOf,
  shouldMarkApplied,
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

  it('preserves failed-pair obligations even when other judgments succeeded', () => {
    const failed = record('supersession', {
      retryable: true,
      withheldWork: [
        {
          nodeIds: ['a', 'b'],
          disposition: 'retryable',
          reason: 'store_unavailable',
          addresses: [{ kind: 'id', id: 'source-1' }],
          revision: buildEvidenceRevision([]),
        },
      ],
    });
    expect.soft(stageSettlementOf(failed)).toBeUndefined();
    expect
      .soft(completionStages(summary([failed]))[0])
      .toMatchObject({ retryable: true, withheldWork: failed.withheldWork });
    recordStageSettlements(store.db, SOURCE, summary([failed]), NOW);
    expect.soft(stateOf('supersession').state).not.toBe('completed');
  });
  it('settles a chain of proved-empty downstream stages within the same acknowledgment', () => {
    const empty = {
      disposition: 'not_applicable' as const,
      reason: 'proved_empty_input' as const,
      proof: { inputCount: 0 },
    };
    recordStageSettlements(
      store.db,
      SOURCE,
      summary([
        record('entities'),
        record('cognitive', { status: 'skipped', retryable: true, settledOnUpstream: empty }),
        record('supersession', { status: 'skipped', retryable: true, settledOnUpstream: empty }),
      ]),
      NOW,
    );
    expect(readGenerationWork(store.db, SOURCE, 1).map((row) => row.state)).toEqual([
      'completed',
      'completed',
      'completed',
    ]);
  });
  it('identifies the configured stage contract rather than only the stage names', () => {
    const before = readinessContractOf(reflectionStages(DEFAULTS));
    const after = readinessContractOf(
      reflectionStages({
        ...DEFAULTS,
        reflection: {
          ...DEFAULTS.reflection,
          minExtractionChars: DEFAULTS.reflection.minExtractionChars + 1,
        },
      }),
    );
    expect(after).not.toEqual(before);
  });
  it('makes a returning policy current instead of leaving the intervening policy selected', () => {
    const first = { pipelineVersion: 'v1', stageNames: STAGES, transferCapabilities: [] };
    const second = { ...first, pipelineVersion: 'v2' };
    publishReadinessPolicy(store.db, second, NOW);
    const selected = publishReadinessPolicy(store.db, first, NOW);
    expect.soft(readCurrentReadinessPolicy(store.db)?.pipelineVersion).toBe('v1');
    expect.soft(readCurrentReadinessPolicy(store.db)?.policyRevision).toBe(selected);
  });
  it('does not close the run-key while a stage explicitly remains retryable', () => {
    expect(
      shouldMarkApplied([
        record('entities'),
        record('supersession', { status: 'skipped', retryable: true }),
      ]),
    ).toBe(false);
  });
  it('represents the signed source-forgotten stage settlement in the publication contract', () => {
    expect(() =>
      reflectionCompletionPublication.decodePayload({
        sourceId: SOURCE,
        jobId: 'job',
        disposition: 'settled',
        processingGeneration: 1,
        operationalRevision: 1,
        acceptedReferenceVersion: 0,
        referencesDigest: '',
        stages: [
          record('entities', {
            status: 'skipped',
            settled: { disposition: 'not_applicable', reason: 'below_minimum_input' },
          }),
        ].map(({ durationMs: _durationMs, ...entry }) => ({
          ...entry,
          settled: {
            disposition: 'not_applicable',
            reason: 'source_forgotten',
            proof: { state: 'v1' },
          },
        })),
      }),
    ).not.toThrow();
  });
});
