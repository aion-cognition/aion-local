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
/**
 * Each runner beside the contract revision this build admits it at.
 *
 * A transferred row names the runner it was handed to and the revision of the contract it was
 * handed under. Both are checked against this table rather than against each other: a runner
 * revision and a capability revision are different axes, and two integers being equal proves
 * nothing about whether the receiving side can run the work.
 */
export const TRANSFER_CAPABILITY_REVISIONS: Readonly<Record<string, number>> = {
  'entity-dedup': 1,
  supersession: 1,
  proposal_resolution: 1,
  reinforcement: 1,
  'context-vectors': 1,
};

export const TRANSFER_CAPABILITIES: readonly string[] = Object.keys(TRANSFER_CAPABILITY_REVISIONS);

/**
 * Whether this build, under the source's accepted policy, admits the transfer a row describes.
 *
 * The policy has to list the runner, this build has to register it, and both the revision the
 * row was handed under and the one the continuation names have to be the registered one. A row
 * naming a revision nobody registered is a row nothing can pick up.
 */
export function admitsTransfer(input: {
  readonly runner: string;
  readonly runnerRevision: number;
  readonly capabilityRevision: number;
  readonly policyCapabilities: readonly string[] | undefined;
}): boolean {
  const registered = TRANSFER_CAPABILITY_REVISIONS[input.runner];
  if (registered === undefined || input.policyCapabilities?.includes(input.runner) !== true) {
    return false;
  }
  return input.runnerRevision === registered && input.capabilityRevision === registered;
}

/**
 * The contract this build's pipeline implies: the stages, in order, AND what each one runs on.
 *
 * The options come from the constructed stages rather than from the config, so the contract is
 * about the pass a source will actually get. A build that raised a stage's minimum input
 * requires something different of a source than the build before it, and a contract naming only
 * the stages would call those two passes the same.
 */
export function readinessContractOf(stages: readonly ReflectionStage[]): ReadinessContract {
  return {
    pipelineVersion: PIPELINE_VERSION,
    stageNames: stages.map((stage) => stage.name),
    stageOptions: Object.fromEntries(stages.map((stage) => [stage.name, stage.describe?.() ?? {}])),
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
