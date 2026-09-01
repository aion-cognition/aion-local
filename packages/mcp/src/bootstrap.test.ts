import {
  DEFAULTS,
  EntityDedupStage,
  NARRATIVE_STAGE_NAME,
  SupersessionStage,
  type Config,
  type ReflectionStage,
} from '@aion/core';
import { describe, expect, it } from 'vitest';

import { narrativeOptions, reflectionStages, workerOptions } from './bootstrap.js';

/**
 * The pipeline and the options the service actually runs with. A stage that exists, is
 * tested, and is registered nowhere is the shape both halves of the narrative trigger were
 * in: built and unreachable. These assertions are about the wiring, not the stages.
 */

const config = DEFAULTS;

/**
 * Every knob below differs from the value the stage would default to on its own. A wiring
 * assertion made against `DEFAULTS` pins nothing: the stage reports the same number with the
 * config line deleted, which is how `AION_ENTITY_MERGE_MODE=propose` could stop reaching the
 * cascade without a test noticing.
 */
const configured: Config = {
  ...DEFAULTS,
  reflection: {
    ...DEFAULTS.reflection,
    entityMergeMode: 'propose',
    entityDedupThreshold: 0.91,
    entityNominationJaccardFloor: 0.42,
    supersedeMode: 'propose',
  },
};

function stageOfType<T extends ReflectionStage>(
  stages: readonly ReflectionStage[],
  is: (stage: ReflectionStage) => stage is T,
): T {
  const found = stages.find(is);
  if (found === undefined) {
    throw new Error('the pipeline registered no stage of that type');
  }
  return found;
}

describe('reflectionStages', () => {
  it('registers the reflection stages in order, narrative evaluation last', () => {
    const names = reflectionStages(config).map((stage) => stage.name);

    expect(names).toEqual([
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

  it('gives the narrative stage the configured idle window rather than its own default', () => {
    expect(narrativeOptions(config).idleMs).toBe(
      config.reflection.narrativeIdleMinutes * 60 * 1000,
    );
    expect(narrativeOptions(config).model).toBe(config.models.reflect);
  });

  it('threads the entity-merge kill switch and both nomination knobs into the dedup stage', () => {
    const dedup = stageOfType(
      reflectionStages(configured),
      (stage): stage is EntityDedupStage => stage instanceof EntityDedupStage,
    );

    expect(dedup.describe()).toMatchObject({
      mode: configured.reflection.entityMergeMode,
      similarityThreshold: configured.reflection.entityDedupThreshold,
      sharedEpisodeJaccardFloor: configured.reflection.entityNominationJaccardFloor,
    });
  });

  it('threads the supersession kill switch into the supersession stage', () => {
    const supersession = stageOfType(
      reflectionStages(configured),
      (stage): stage is SupersessionStage => stage instanceof SupersessionStage,
    );

    expect(supersession.describe()).toMatchObject({
      mode: configured.reflection.supersedeMode,
    });
  });
});

describe('workerOptions', () => {
  it('threads the operational knobs the worker reads', () => {
    expect(workerOptions(config)).toEqual({
      workerCount: config.operational.workerCount,
      staleTimeoutMs: config.operational.workerStaleClaimTimeoutMs,
      retryBaseMs: config.operational.workerRetryBaseMs,
      retryCapMs: config.operational.workerRetryCapMs,
      maxAttempts: config.operational.workerMaxAttempts,
      breakerThreshold: config.operational.workerBreakerThreshold,
      breakerCooldownMs: config.operational.workerBreakerCooldownMs,
      vectorBatchSize: config.operational.workerVectorBatchSize,
    });
  });
});
