/**
 * The reflection layer's public surface: intake, the orchestrator and its stages, the worker,
 * narratives, lag, and the proposal review path.
 */

export { handleReflection } from './application/intake.js';
export type { ReflectionIntakeDeps } from './application/intake.js';

export { LaneAssigner } from './application/lanes.js';

export { reconcileEnrichment } from './application/reconcile.js';

export { queueLagSnapshot } from './application/lag.js';
export type { QueueLagSnapshot } from './application/lag.js';

export { ReflectionNotStoredError } from './application/errors.js';

export {
  applyEntityMergeProposal,
  dismissEntityMergeProposal,
  ENTITY_MERGE_APPLY_METHOD,
} from './application/entity-merge-review.js';
export type {
  ApplyEntityMergeProposalInput,
  ApplyEntityMergeProposalResult,
  DismissEntityMergeProposalResult,
  EntityMergeAlreadyApplied,
  EntityMergeAlreadyResolved,
  EntityMergeApplied,
  EntityMergeStale,
} from './application/entity-merge-review.js';

export type { ReflectionStage } from './domain/stage.js';

export { ReflectionOrchestrator, orchestratorLedgerKey } from './application/orchestrator.js';

export { ReflectionWorker } from './application/worker.js';
export type { ReflectionWorkerOptions } from './application/worker.js';

export { findPendingVectorNodes } from './application/vectors.js';

export { EntityExtractionStage } from './application/stages/entities.js';

export { DEFAULT_ENTITY_MERGE_MODE, EntityDedupStage } from './application/stages/entity-dedup.js';
export type {
  EntityDedupStageOptions,
  EntityMergeMode,
} from './application/stages/entity-dedup.js';

export {
  describeEntityMergePair,
  judgeEntityMerge,
  reviewEntityMerge,
} from './application/entity-merge-judge.js';
export type { EntityMergePair, EntityMergeSide } from './application/entity-merge-judge.js';

export { applyEntityMerge, collectMergeSignals } from './application/entity-merge-writer.js';

export { AssociationInferenceStage } from './application/stages/associations.js';

export { CognitiveExtractionStage } from './application/stages/cognitive.js';

export { SemanticRelationshipStage } from './application/stages/semantic-relationships.js';

export { judgeContradiction, SupersessionStage } from './application/stages/supersession.js';
export type { ContradictionJudgment, SupersessionMode } from './application/stages/supersession.js';

export {
  describeVeto,
  reviewContradiction,
  vetoForUnansweredReview,
} from './application/stages/supersession-review.js';
export type {
  ReviewOutcome,
  ReviewPair,
  ReviewVerdict,
  VetoCheck,
} from './application/stages/supersession-review.js';

export { ReinforcementEnqueueStage } from './application/stages/reinforcement.js';

export { ContextVectorStage } from './application/stages/context-vectors.js';

export {
  NARRATIVE_STAGE_NAME,
  SessionNarrativeCloser,
  SessionNarrativeStage,
  closeSessionNarrative,
} from './application/narratives.js';
export type { NarrativeDeps, SessionNarrativeOptions } from './application/narratives.js';

export { IdleNarrativeSweeper } from './application/narrative-sweeper.js';

export {
  applySupersessionProposal,
  DEFAULT_APPLY_SCOPE,
  dismissSupersessionProposal,
  ProposalNotFoundError,
  PROPOSAL_APPLY_METHOD,
  UNANIMOUS_APPLY_METHOD,
  UNANIMOUS_APPLY_SIGNALS,
} from './application/proposals.js';
export type { ApplyAttribution, ApplyScope } from './application/proposals.js';
