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
} from './application/entity-merge-review.js';
export type { ApplyEntityMergeProposalResult } from './application/entity-merge-review.js';

export type { ReflectionStage } from './domain/stage.js';

export { PIPELINE_VERSION } from './domain/version.js';

export { ReflectionOrchestrator, orchestratorLedgerKey } from './application/orchestrator.js';

export { ReflectionWorker } from './application/worker.js';
export type { ReflectionWorkerOptions } from './application/worker.js';

export { findPendingVectorNodes } from './application/vectors.js';

export { EntityExtractionStage } from './application/stages/entities.js';

export { DEFAULT_ENTITY_MERGE_MODE, EntityDedupStage } from './application/stages/entity-dedup.js';

export { AssociationInferenceStage } from './application/stages/associations.js';

export { CognitiveExtractionStage } from './application/stages/cognitive.js';

export { SemanticRelationshipStage } from './application/stages/semantic-relationships.js';

export { judgeContradiction, SupersessionStage } from './application/stages/supersession.js';
export type { ContradictionJudgment } from './application/stages/supersession.js';

export { reviewContradiction } from './application/stages/supersession-review.js';
export type { ReviewVerdict, VetoCheck } from './application/stages/supersession-review.js';

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
  UNANIMOUS_APPLY_METHOD,
} from './application/proposals.js';
export type { ApplyScope } from './application/proposals.js';
