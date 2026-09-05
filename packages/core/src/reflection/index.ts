/**
 * The reflection layer's public surface. Every name here is one something outside core imports:
 * intake and lane assignment, the orchestrator and the stages consumers construct directly, the
 * worker, replay, narratives and the episode timeline, lag, enrichment reconcile, and the
 * proposal review path. The stages the pipeline wires for itself stay unexported.
 */

export { handleReflection, INTEGRATE_JOB_TYPE } from './application/intake.js';
export type { ReflectionIntakeDeps } from './application/intake.js';

export { LaneAssigner } from './application/lanes.js';

export { recordLifecycleEvent } from './application/lifecycle-events.js';

export { reconcileEnrichment } from './application/reconcile.js';

export { queueLagSnapshot } from './application/lag.js';
export type { QueueLagSnapshot } from './application/lag.js';

export { ReflectionNotStoredError } from './application/errors.js';

export {
  applyEntityMergeProposal,
  dismissEntityMergeProposal,
} from './application/entity-merge-review.js';
export type { ApplyEntityMergeProposalResult } from './application/entity-merge-review.js';

export { stageLedgerKey } from './domain/stage.js';
export type { ReflectionStage } from './domain/stage.js';

export { PIPELINE_VERSION } from './domain/version.js';

export { ReflectionOrchestrator, orchestratorLedgerKey } from './application/orchestrator.js';

export {
  associationOptions,
  cognitiveOptions,
  entityDedupOptions,
  entityOptions,
  narrativeOptions,
  narrativeSweepOptions,
  reflectionStages,
  reinforcementOptions,
  semanticRelationshipOptions,
  supersessionOptions,
  workerOptions,
} from './application/pipeline.js';

export { replayExperiences } from './application/replay.js';
export type {
  ReplayDeps,
  ReplayProgress,
  ReplayReport,
  ReplaySelection,
} from './application/replay.js';

export { replayUsageEvents } from './application/usage-replay.js';
export type { UsageReplayProgress, UsageReplayReport } from './application/usage-replay.js';

export { buildEpisodeTimeline } from './application/episode-timeline.js';
export type { TimelineEvent } from './application/episode-timeline.js';

export { ReflectionWorker } from './application/worker.js';

export { EntityExtractionStage } from './application/stages/entities.js';

export { EntityDedupStage } from './application/stages/entity-dedup.js';

export { AssociationInferenceStage } from './application/stages/associations.js';

export { judgeContradiction, SupersessionStage } from './application/stages/supersession.js';
export type { ContradictionJudgment } from './application/stages/supersession.js';

export { reviewContradiction } from './application/stages/supersession-review.js';
export type { ReviewVerdict, VetoCheck } from './application/stages/supersession-review.js';

export { ContextVectorStage } from './application/stages/context-vectors.js';

export {
  NARRATIVE_STAGE_NAME,
  SessionNarrativeCloser,
  closeSessionNarrative,
} from './application/narratives.js';
export type { NarrativeDeps } from './application/narratives.js';

export { IdleNarrativeSweeper } from './application/narrative-sweeper.js';

export {
  applySupersessionProposal,
  DEFAULT_APPLY_SCOPE,
  dismissSupersessionProposal,
  ProposalNotFoundError,
  UNANIMOUS_APPLY_METHOD,
} from './application/proposals.js';
export type { ApplyScope } from './application/proposals.js';
