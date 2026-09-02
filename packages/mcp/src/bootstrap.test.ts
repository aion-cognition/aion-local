import {
  AssociationInferenceStage,
  associationOptions,
  cognitiveOptions,
  DEFAULTS,
  entityDedupOptions,
  EntityDedupStage,
  EntityExtractionStage,
  entityOptions,
  NARRATIVE_STAGE_NAME,
  reinforcementOptions,
  semanticRelationshipOptions,
  supersessionOptions,
  SupersessionStage,
  type Config,
  type ReflectionStage,
} from '@aion/core';
import { describe, expect, it } from 'vitest';

import {
  narrativeOptions,
  narrativeSweepOptions,
  reflectionStages,
  workerOptions,
} from './bootstrap.js';

/**
 * The pipeline and the options the service actually runs with. A stage that exists, is
 * tested, and is registered nowhere is the shape both halves of the narrative trigger were
 * in: built and unreachable. These assertions are about the wiring, not the stages.
 *
 * Every leaf below differs from the value the stage falls back to on its own, and every
 * assertion is `toEqual` rather than `toMatchObject`, so a knob the wiring stops threading
 * fails here instead of running the constructor default under a deployment that set something
 * else. `familyRelatednessFloor` is the leaf that proves the shape: the retro sweep built a
 * supersession stage of its own without it for as long as the option list was written twice.
 */

const MINUTE_MS = 60 * 1000;

/** The dedup stage's judged-pair ceiling is a constructor option and not a knob, so the wiring leaves it alone. */
const DEDUP_MAX_JUDGMENTS = 8;

const configured: Config = {
  ...DEFAULTS,
  models: { ...DEFAULTS.models, reflect: 'wiring-probe-model' },
  hebbian: { ...DEFAULTS.hebbian, weightFloor: 0.13 },
  sqlite: { ...DEFAULTS.sqlite, reinforcementQueueCap: 4_242 },
  temporal: { ...DEFAULTS.temporal, readingHorizonDays: 31 },
  operational: {
    ...DEFAULTS.operational,
    workerCount: 3,
    workerStaleClaimTimeoutMs: 601_000,
    workerRetryBaseMs: 5_100,
    workerRetryCapMs: 301_000,
    workerMaxAttempts: 6,
    workerBreakerThreshold: 7,
    workerBreakerCooldownMs: 61_000,
    workerVectorBatchSize: 65,
  },
  reflection: {
    ...DEFAULTS.reflection,
    stageTimeoutMs: 61_000,
    maxEntities: 31,
    entityDedupThreshold: 0.91,
    entityNominationJaccardFloor: 0.42,
    entityMergeMode: 'propose',
    associationSemanticThreshold: 0.71,
    associationSimilarLimit: 6,
    maxCognitiveNodes: 21,
    maxRelationships: 41,
    supersedeMode: 'propose',
    keyedCloseMode: 'off',
    supersedeAutoConfidence: 0.81,
    supersedeNeighborThreshold: 0.72,
    supersedeFamilyRelatednessFloor: 0.63,
    maxSupersessionSubjects: 7,
    maxContradictionNeighbors: 4,
    maxContradictionJudgments: 9,
    narrativeIdleMinutes: 31,
    maxNarrativeEpisodes: 41,
    maxNarrativeEpisodeChars: 2_100,
    narrativeSweepLimit: 21,
  },
};

const stages = reflectionStages(configured);

const wiredSupersessionOptions = {
  model: configured.models.reflect,
  timeoutMs: configured.reflection.stageTimeoutMs,
  mode: configured.reflection.supersedeMode,
  autoConfidence: configured.reflection.supersedeAutoConfidence,
  neighborThreshold: configured.reflection.supersedeNeighborThreshold,
  maxSubjects: configured.reflection.maxSupersessionSubjects,
  maxNeighbors: configured.reflection.maxContradictionNeighbors,
  maxJudgments: configured.reflection.maxContradictionJudgments,
  familyRelatednessFloor: configured.reflection.supersedeFamilyRelatednessFloor,
  keyedCloseMode: configured.reflection.keyedCloseMode,
};

function stageOfType<T extends ReflectionStage>(
  found: readonly ReflectionStage[],
  is: (stage: ReflectionStage) => stage is T,
): T {
  const match = found.find(is);
  if (match === undefined) {
    throw new Error('the pipeline registered no stage of that type');
  }
  return match;
}

/** The leaves the fixture left at their default, which are the leaves its assertions cannot pin. */
function leavesLeftAtDefault(): readonly string[] {
  const probe: Record<string, unknown> = configured.reflection;
  return Object.entries(DEFAULTS.reflection)
    .filter(([leaf, value]) => probe[leaf] === value)
    .map(([leaf]) => leaf);
}

describe('reflectionStages', () => {
  it('registers the reflection stages in order, narrative evaluation last', () => {
    expect(stages.map((stage) => stage.name)).toEqual([
      'entities',
      'entity-dedup',
      'associations',
      'cognitive',
      'semantic-relationships',
      'supersession',
      'reinforcement',
      'context-vectors',
      NARRATIVE_STAGE_NAME,
    ]);
  });

  it('moves every reflection knob off its default, so a wiring assertion pins something', () => {
    expect(leavesLeftAtDefault()).toEqual([]);
  });

  it('gives entity extraction the configured model, hang guard and cap', () => {
    const entities = stageOfType(
      stages,
      (stage): stage is EntityExtractionStage => stage instanceof EntityExtractionStage,
    );

    expect(entities.describe()).toEqual({
      model: configured.models.reflect,
      timeoutMs: configured.reflection.stageTimeoutMs,
      maxEntities: configured.reflection.maxEntities,
    });
    expect(entityOptions(configured)).toEqual(entities.describe());
  });

  it('gives entity dedup the kill switch, both nomination knobs and its own judged-pair cap', () => {
    const dedup = stageOfType(
      stages,
      (stage): stage is EntityDedupStage => stage instanceof EntityDedupStage,
    );

    expect(dedup.describe()).toEqual({
      model: configured.models.reflect,
      timeoutMs: configured.reflection.stageTimeoutMs,
      similarityThreshold: configured.reflection.entityDedupThreshold,
      sharedEpisodeJaccardFloor: configured.reflection.entityNominationJaccardFloor,
      mode: configured.reflection.entityMergeMode,
      maxJudgments: DEDUP_MAX_JUDGMENTS,
    });
    expect(entityDedupOptions(configured)).toEqual({
      model: configured.models.reflect,
      timeoutMs: configured.reflection.stageTimeoutMs,
      similarityThreshold: configured.reflection.entityDedupThreshold,
      sharedEpisodeJaccardFloor: configured.reflection.entityNominationJaccardFloor,
      mode: configured.reflection.entityMergeMode,
    });
  });

  it('gives association inference both thresholds and the plasticity weight floor', () => {
    const associations = stageOfType(
      stages,
      (stage): stage is AssociationInferenceStage => stage instanceof AssociationInferenceStage,
    );

    expect(associations.describe()).toEqual({
      semanticThreshold: configured.reflection.associationSemanticThreshold,
      similarLimit: configured.reflection.associationSimilarLimit,
      weightFloor: configured.hebbian.weightFloor,
    });
    expect(associationOptions(configured)).toEqual(associations.describe());
  });

  it('gives the supersession stage and the retro sweep the same ten options', () => {
    const supersession = stageOfType(
      stages,
      (stage): stage is SupersessionStage => stage instanceof SupersessionStage,
    );

    expect(supersession.describe()).toEqual(wiredSupersessionOptions);
    expect(supersessionOptions(configured)).toEqual(wiredSupersessionOptions);
  });

  it('builds cognitive extraction, semantic relationships and reinforcement from the same config', () => {
    expect(cognitiveOptions(configured)).toEqual({
      model: configured.models.reflect,
      timeoutMs: configured.reflection.stageTimeoutMs,
      maxNodes: configured.reflection.maxCognitiveNodes,
      keyedCloseMode: configured.reflection.keyedCloseMode,
      familyRelatednessFloor: configured.reflection.supersedeFamilyRelatednessFloor,
      readingHorizonDays: configured.temporal.readingHorizonDays,
    });
    expect(semanticRelationshipOptions(configured)).toEqual({
      model: configured.models.reflect,
      timeoutMs: configured.reflection.stageTimeoutMs,
      maxRelationships: configured.reflection.maxRelationships,
    });
    expect(reinforcementOptions(configured)).toEqual({
      reinforcementQueueCap: configured.sqlite.reinforcementQueueCap,
    });
  });
});

describe('narrativeOptions', () => {
  it('threads the configured idle window and both source caps', () => {
    expect(narrativeOptions(configured)).toEqual({
      model: configured.models.reflect,
      idleMs: configured.reflection.narrativeIdleMinutes * MINUTE_MS,
      timeoutMs: configured.reflection.stageTimeoutMs,
      maxSourceEpisodes: configured.reflection.maxNarrativeEpisodes,
      maxEpisodeChars: configured.reflection.maxNarrativeEpisodeChars,
    });
  });

  it('adds the sweep limit to the same options the closer runs on', () => {
    expect(narrativeSweepOptions(configured)).toEqual({
      ...narrativeOptions(configured),
      limit: configured.reflection.narrativeSweepLimit,
    });
  });
});

describe('workerOptions', () => {
  it('threads the operational knobs the worker reads', () => {
    expect(workerOptions(configured)).toEqual({
      workerCount: configured.operational.workerCount,
      staleTimeoutMs: configured.operational.workerStaleClaimTimeoutMs,
      retryBaseMs: configured.operational.workerRetryBaseMs,
      retryCapMs: configured.operational.workerRetryCapMs,
      maxAttempts: configured.operational.workerMaxAttempts,
      breakerThreshold: configured.operational.workerBreakerThreshold,
      breakerCooldownMs: configured.operational.workerBreakerCooldownMs,
      vectorBatchSize: configured.operational.workerVectorBatchSize,
    });
  });
});
