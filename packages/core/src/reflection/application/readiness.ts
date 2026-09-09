import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { readActiveGeneration } from '../../infrastructure/sqlite/processing-generations.js';
import {
  publishReadinessPolicy,
  type ReadinessContract,
} from '../../infrastructure/sqlite/readiness-policies.js';
import {
  readGenerationWork,
  readPolicyStages,
} from '../../infrastructure/sqlite/source-readiness.js';
import { evaluateProcessingReadiness, type ProcessingReadiness } from '../domain/readiness.js';
import type { ReflectionStage } from '../domain/stage.js';
import { PIPELINE_VERSION } from '../domain/version.js';

/**
 * What readiness requires, taken from the one production stage list, and what a given source has
 * made of it.
 *
 * The contract is derived from the stages the service actually constructs rather than from a
 * second list beside them. A stage that joins the pipeline joins the contract on the same edit,
 * and a stage that is only in the contract would be a required pass nothing can ever run.
 */

/**
 * Runners a transferred obligation may name in this version.
 *
 * A transfer leaves the obligation outstanding and moves who runs it, so a runner that cannot
 * read a source through the durable records would leave the work owed and unrunnable once the
 * raw projection is gone. Only the paths that read that way are listed; an obligation naming
 * anything else pins its source instead of transferring.
 */
export const TRANSFER_CAPABILITIES: readonly string[] = [
  'entity-dedup',
  'supersession',
  'proposal_resolution',
  'reinforcement',
  'context-vectors',
];

export function readinessContractOf(stages: readonly ReflectionStage[]): ReadinessContract {
  return {
    pipelineVersion: PIPELINE_VERSION,
    stageNames: stages.map((stage) => stage.name),
    transferCapabilities: TRANSFER_CAPABILITIES,
  };
}

/**
 * Publishes the contract this build's pipeline implies, and answers with the revision in force.
 *
 * Called once at startup, before anything can accept a source: a source accepted with no policy
 * published records a durable inventory obligation instead of a stage list, and the obligation is
 * more expensive to clear than the policy is to publish.
 */
export function publishPipelineReadinessPolicy(
  db: SqliteHandle,
  stages: readonly ReflectionStage[],
  now: Date,
): number {
  return publishReadinessPolicy(db, readinessContractOf(stages), now);
}

/**
 * One source's readiness, from the records alone.
 *
 * The stage set comes from the policy revision the SOURCE was accepted under, read back from the
 * store, not from today's pipeline. A source whose policy revision is missing answers unknown:
 * there is no list to measure it against, and measuring it against the current one would judge an
 * old pass by a contract it never accepted.
 */
export function processingReadinessOf(db: SqliteHandle, sourceId: string): ProcessingReadiness {
  const generation = readActiveGeneration(db, sourceId);
  if (generation === undefined) {
    return evaluateProcessingReadiness({
      sourceId,
      generation: undefined,
      requiredStages: undefined,
      work: [],
    });
  }
  return evaluateProcessingReadiness({
    sourceId,
    generation: {
      processingGeneration: generation.processingGeneration,
      policyRevision: generation.policyRevision,
      inputDigest: generation.inputDigest,
      operationalRevision: generation.operationalRevision,
    },
    requiredStages: readPolicyStages(db, generation.policyRevision),
    work: readGenerationWork(db, sourceId, generation.processingGeneration),
  });
}
