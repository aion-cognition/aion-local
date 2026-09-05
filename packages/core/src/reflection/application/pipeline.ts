import { SessionNarrativeStage, type SessionNarrativeOptions } from './narratives.js';
import { AssociationInferenceStage, type AssociationStageOptions } from './stages/associations.js';
import {
  CognitiveExtractionStage,
  type CognitiveExtractionStageOptions,
} from './stages/cognitive.js';
import { ContextVectorStage } from './stages/context-vectors.js';
import { EntityExtractionStage, type EntityStageOptions } from './stages/entities.js';
import { EntityDedupStage, type EntityDedupStageOptions } from './stages/entity-dedup.js';
import {
  ReinforcementEnqueueStage,
  type ReinforcementEnqueueStageOptions,
} from './stages/reinforcement.js';
import {
  SemanticRelationshipStage,
  type SemanticRelationshipStageOptions,
} from './stages/semantic-relationships.js';
import { SupersessionStage, type SupersessionStageOptions } from './stages/supersession.js';
import type { ReflectionWorkerOptions } from './worker.js';
import type { Config } from '../../infrastructure/config/schema.js';
import type { ReflectionStage } from '../domain/stage.js';

/**
 * The pipeline's order and the options every stage runs on, beside the stage contract they
 * belong to. Anything that builds a stage builds it from here: a second copy of an option list
 * drifts from the first the moment a knob joins, which is how the retro judgment sweep came to
 * run a supersession stage with no `familyRelatednessFloor` at all.
 *
 * Each builder returns its stage's whole options type rather than a `Partial` of it, so a knob
 * the wiring never threads is a compile error instead of a stage quietly answering with its
 * constructor default. The constructors still take partial options: a stage built bare in a
 * test is a legitimate shape, and its defaults are what that shape documents.
 */

const MINUTE_MS = 60 * 1000;

/**
 * Every narrative option the running service supplies. `regenerate` stays out: it is a cleanup
 * flag one command sets on a single call, not a knob the pipeline threads. `signal` stays out
 * too: it is the run's own shutdown signal, handed to the stage by the orchestrator.
 */
export type WiredNarrativeOptions = Required<
  Omit<SessionNarrativeOptions, 'regenerate' | 'signal'>
>;

/** The idle sweep runs the closer's options and one bound of its own. */
export type NarrativeSweepOptions = WiredNarrativeOptions & { readonly limit: number };

export function entityOptions(config: Config): EntityStageOptions {
  return {
    model: config.models.reflect,
    timeoutMs: config.reflection.stageTimeoutMs,
    maxEntities: config.reflection.maxEntities,
  };
}

/** `maxJudgments` is absent because the cascade's judged-pair ceiling is a constructor option and not a knob. */
export function entityDedupOptions(config: Config): Omit<EntityDedupStageOptions, 'maxJudgments'> {
  return {
    model: config.models.reflect,
    timeoutMs: config.reflection.stageTimeoutMs,
    similarityThreshold: config.reflection.entityDedupThreshold,
    sharedEpisodeJaccardFloor: config.reflection.entityNominationJaccardFloor,
    mode: config.reflection.entityMergeMode,
  };
}

export function associationOptions(config: Config): AssociationStageOptions {
  return {
    semanticThreshold: config.reflection.associationSemanticThreshold,
    similarLimit: config.reflection.associationSimilarLimit,
    weightFloor: config.hebbian.weightFloor,
  };
}

/**
 * The keyed close rides on this stage's write, so its mode and the family floor it closes
 * siblings under are threaded here rather than with the judge's options.
 */
export function cognitiveOptions(config: Config): CognitiveExtractionStageOptions {
  return {
    model: config.models.reflect,
    timeoutMs: config.reflection.stageTimeoutMs,
    maxNodes: config.reflection.maxCognitiveNodes,
    keyedCloseMode: config.reflection.keyedCloseMode,
    familyRelatednessFloor: config.reflection.supersedeFamilyRelatednessFloor,
    readingHorizonDays: config.temporal.readingHorizonDays,
    intentionHorizonDays: config.temporal.intentionHorizonDays,
  };
}

export function semanticRelationshipOptions(
  config: Config,
): Required<SemanticRelationshipStageOptions> {
  return {
    model: config.models.reflect,
    timeoutMs: config.reflection.stageTimeoutMs,
    maxRelationships: config.reflection.maxRelationships,
  };
}

export function supersessionOptions(config: Config): SupersessionStageOptions {
  return {
    model: config.models.reflect,
    timeoutMs: config.reflection.stageTimeoutMs,
    mode: config.reflection.supersedeMode,
    autoConfidence: config.reflection.supersedeAutoConfidence,
    neighborThreshold: config.reflection.supersedeNeighborThreshold,
    maxSubjects: config.reflection.maxSupersessionSubjects,
    maxNeighbors: config.reflection.maxContradictionNeighbors,
    maxJudgments: config.reflection.maxContradictionJudgments,
    familyRelatednessFloor: config.reflection.supersedeFamilyRelatednessFloor,
    // The same knob the cognitive stage reads, threaded to both because one value decides two
    // things: whether the write closes a keyed pair, and whether this stage judges one.
    keyedCloseMode: config.reflection.keyedCloseMode,
  };
}

export function reinforcementOptions(config: Config): Required<ReinforcementEnqueueStageOptions> {
  return { reinforcementQueueCap: config.sqlite.reinforcementQueueCap };
}

export function narrativeOptions(config: Config): WiredNarrativeOptions {
  return {
    model: config.models.reflect,
    idleMs: config.reflection.narrativeIdleMinutes * MINUTE_MS,
    timeoutMs: config.reflection.stageTimeoutMs,
    reflection: config.reflection,
    midSession: config.reflection.midSessionRollup,
    midSessionEpisodes: config.reflection.midSessionEpisodes,
    midSessionGapMs: config.reflection.midSessionGapMinutes * MINUTE_MS,
  };
}

export function narrativeSweepOptions(config: Config): NarrativeSweepOptions {
  return { ...narrativeOptions(config), limit: config.reflection.narrativeSweepLimit };
}

/** `clock` is absent because the worker reads the wall clock unless a test or a replay hands it one. */
export function workerOptions(config: Config): Required<Omit<ReflectionWorkerOptions, 'clock'>> {
  return {
    workerCount: config.operational.workerCount,
    staleTimeoutMs: config.operational.workerStaleClaimTimeoutMs,
    retryBaseMs: config.operational.workerRetryBaseMs,
    retryCapMs: config.operational.workerRetryCapMs,
    maxAttempts: config.operational.workerMaxAttempts,
    breakerThreshold: config.operational.workerBreakerThreshold,
    breakerCooldownMs: config.operational.workerBreakerCooldownMs,
    vectorBatchSize: config.operational.workerVectorBatchSize,
  };
}

/**
 * The pipeline, in the one place its order lives. Identity is resolved before anything reads
 * it: extraction, then deduplication, because a later stage that pairs, links, or judges
 * duplicate entities writes the duplication into the graph as structure. Supersession
 * follows cognitive extraction, since the facts it judges are the Decision and Insight nodes
 * that stage writes. Context vectors run last: they aggregate over whatever the rest of the
 * run just changed.
 *
 * Narrative evaluation is last. It carries the idle rule rather than the close: a session
 * whose episodes are reflecting seconds after they arrived is still open, and the stage
 * skips it, leaving the narrative to `SessionNarrativeCloser`. What it catches is the other
 * case: a backlog drained hours late, or a retry that landed after the client was gone,
 * where no close hook will ever fire again.
 *
 * An empty list would leave the worker down: an orchestrator with nothing to run enriches
 * nothing, which reads to the worker as a failed job and spends the episode's retries on it.
 */
export function reflectionStages(config: Config): readonly ReflectionStage[] {
  return [
    new EntityExtractionStage(entityOptions(config)),
    new EntityDedupStage(entityDedupOptions(config)),
    new AssociationInferenceStage(associationOptions(config)),
    new CognitiveExtractionStage(cognitiveOptions(config)),
    new SemanticRelationshipStage(semanticRelationshipOptions(config)),
    new SupersessionStage(supersessionOptions(config)),
    new ReinforcementEnqueueStage(reinforcementOptions(config)),
    new ContextVectorStage(),
    new SessionNarrativeStage(narrativeOptions(config)),
  ];
}
