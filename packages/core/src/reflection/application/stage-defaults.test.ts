import { describe, expect, it } from 'vitest';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { DEFAULT_REINFORCEMENT_QUEUE_CAP } from '../../infrastructure/sqlite/reinforcement-queue.js';
import {
  DEFAULT_BREAKER_COOLDOWN_MS,
  DEFAULT_BREAKER_THRESHOLD,
  DEFAULT_DRAIN_STALE_TIMEOUT_MS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_RETRY_BASE_MS,
  DEFAULT_RETRY_CAP_MS,
  DEFAULT_VECTOR_BATCH_SIZE,
  DEFAULT_WORKER_COUNT,
} from './worker.js';
import {
  DEFAULT_IDLE_SWEEP_LIMIT,
  DEFAULT_MAX_EPISODE_CHARS,
  DEFAULT_MAX_SOURCE_EPISODES,
  DEFAULT_NARRATIVE_TIMEOUT_MS,
  DEFAULT_SESSION_IDLE_MS,
} from './narratives.js';
import {
  DEFAULT_ASSOCIATION_SEMANTIC_THRESHOLD,
  DEFAULT_ASSOCIATION_SIMILAR_LIMIT,
  DEFAULT_ASSOCIATION_WEIGHT_FLOOR,
} from './stages/associations.js';
import { DEFAULT_COGNITIVE_TIMEOUT_MS, DEFAULT_MAX_COGNITIVE_NODES } from './stages/cognitive.js';
import { DEFAULT_ENTITY_DEDUP_SIMILARITY_THRESHOLD } from './stages/entity-dedup.js';
import { DEFAULT_ENTITY_TIMEOUT_MS, DEFAULT_MAX_ENTITIES } from './stages/entities.js';
import {
  DEFAULT_MAX_RELATIONSHIPS,
  DEFAULT_SEMANTIC_RELATIONSHIP_TIMEOUT_MS,
} from './stages/semantic-relationships.js';
import {
  DEFAULT_CONTRADICTION_NEIGHBOR_THRESHOLD,
  DEFAULT_MAX_CONTRADICTION_JUDGMENTS,
  DEFAULT_MAX_CONTRADICTION_NEIGHBORS,
  DEFAULT_MAX_SUPERSESSION_SUBJECTS,
  DEFAULT_SUPERSEDE_AUTO_CONFIDENCE,
  DEFAULT_SUPERSEDE_MODE,
  DEFAULT_SUPERSESSION_TIMEOUT_MS,
} from './stages/supersession.js';

/**
 * A stage declares its pinned default as a module constant and the service threads config
 * over it, so the two are one value expressed twice. Nothing but this file makes them agree:
 * change a constant without its knob and the shipped pipeline silently keeps the old number,
 * because the thread always wins.
 */

const MINUTE_MS = 60 * 1000;

describe('reflection config defaults', () => {
  it('threads the same numbers the stages pin', () => {
    const reflection = DEFAULTS.reflection;

    expect(reflection.entityTimeoutMs).toBe(DEFAULT_ENTITY_TIMEOUT_MS);
    expect(reflection.maxEntities).toBe(DEFAULT_MAX_ENTITIES);
    expect(reflection.entityDedupThreshold).toBe(DEFAULT_ENTITY_DEDUP_SIMILARITY_THRESHOLD);
    expect(reflection.associationSemanticThreshold).toBe(DEFAULT_ASSOCIATION_SEMANTIC_THRESHOLD);
    expect(reflection.associationSimilarLimit).toBe(DEFAULT_ASSOCIATION_SIMILAR_LIMIT);
    // The co-occurrence clamp is plasticity's floor, not a knob of its own: an association
    // written under the floor would be an edge recall refuses to walk the moment it is made.
    expect(DEFAULTS.hebbian.weightFloor).toBe(DEFAULT_ASSOCIATION_WEIGHT_FLOOR);
    expect(reflection.cognitiveTimeoutMs).toBe(DEFAULT_COGNITIVE_TIMEOUT_MS);
    expect(reflection.maxCognitiveNodes).toBe(DEFAULT_MAX_COGNITIVE_NODES);
    expect(reflection.semanticTimeoutMs).toBe(DEFAULT_SEMANTIC_RELATIONSHIP_TIMEOUT_MS);
    expect(reflection.maxRelationships).toBe(DEFAULT_MAX_RELATIONSHIPS);
    expect(reflection.supersedeMode).toBe(DEFAULT_SUPERSEDE_MODE);
    expect(reflection.supersedeAutoConfidence).toBe(DEFAULT_SUPERSEDE_AUTO_CONFIDENCE);
    expect(reflection.supersedeNeighborThreshold).toBe(DEFAULT_CONTRADICTION_NEIGHBOR_THRESHOLD);
    expect(reflection.supersedeTimeoutMs).toBe(DEFAULT_SUPERSESSION_TIMEOUT_MS);
    expect(reflection.maxSupersessionSubjects).toBe(DEFAULT_MAX_SUPERSESSION_SUBJECTS);
    expect(reflection.maxContradictionNeighbors).toBe(DEFAULT_MAX_CONTRADICTION_NEIGHBORS);
    expect(reflection.maxContradictionJudgments).toBe(DEFAULT_MAX_CONTRADICTION_JUDGMENTS);
  });

  it('states the narrative idle window in minutes, matching the milliseconds the closer pins', () => {
    expect(DEFAULTS.reflection.narrativeIdleMinutes * MINUTE_MS).toBe(DEFAULT_SESSION_IDLE_MS);
    expect(DEFAULTS.reflection.narrativeTimeoutMs).toBe(DEFAULT_NARRATIVE_TIMEOUT_MS);
    expect(DEFAULTS.reflection.maxNarrativeEpisodes).toBe(DEFAULT_MAX_SOURCE_EPISODES);
    expect(DEFAULTS.reflection.maxNarrativeEpisodeChars).toBe(DEFAULT_MAX_EPISODE_CHARS);
    expect(DEFAULTS.reflection.narrativeSweepLimit).toBe(DEFAULT_IDLE_SWEEP_LIMIT);
  });

  it('threads the same numbers the worker pins', () => {
    const operational = DEFAULTS.operational;

    expect(operational.workerCount).toBe(DEFAULT_WORKER_COUNT);
    expect(operational.workerStaleClaimTimeoutMs).toBe(DEFAULT_DRAIN_STALE_TIMEOUT_MS);
    expect(operational.workerRetryBaseMs).toBe(DEFAULT_RETRY_BASE_MS);
    expect(operational.workerRetryCapMs).toBe(DEFAULT_RETRY_CAP_MS);
    expect(operational.workerMaxAttempts).toBe(DEFAULT_MAX_ATTEMPTS);
    expect(operational.workerBreakerThreshold).toBe(DEFAULT_BREAKER_THRESHOLD);
    expect(operational.workerBreakerCooldownMs).toBe(DEFAULT_BREAKER_COOLDOWN_MS);
    expect(operational.workerVectorBatchSize).toBe(DEFAULT_VECTOR_BATCH_SIZE);
  });

  it('threads the same cap the reinforcement queue pins', () => {
    expect(DEFAULTS.sqlite.reinforcementQueueCap).toBe(DEFAULT_REINFORCEMENT_QUEUE_CAP);
  });
});
