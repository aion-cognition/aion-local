import { DEFAULTS, NARRATIVE_STAGE_NAME, type Config } from '@aion/core';
import { describe, expect, it } from 'vitest';
import { narrativeOptions, reflectionStages, workerOptions } from './bootstrap.js';

/**
 * The pipeline and the options the service actually runs with. A stage that exists, is
 * tested, and is registered nowhere is the shape both halves of the narrative trigger were
 * in: built and unreachable. These assertions are about the wiring, not the stages.
 */

const config = DEFAULTS as Config;

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
    expect(narrativeOptions(config).idleMs).toBe(config.reflection.narrativeIdleMinutes * 60 * 1000);
    expect(narrativeOptions(config).model).toBe(config.models.reflect);
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
