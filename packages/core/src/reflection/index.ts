/**
 * The reflection layer's public surface: intake, the orchestrator and its stages, the worker,
 * narratives, lag, and the proposal review path.
 */

export {
  INTAKE_EXTRACTION_METHOD,
  INTEGRATE_JOB_TYPE,
  handleReflection,
} from './application/intake.js';
export type { ReflectionIntakeDeps, ReflectionIntakeOptions } from './application/intake.js';

export { LaneAssigner } from './application/lanes.js';
export type { LaneAssignerOptions, LaneDecision, LaneRequest } from './application/lanes.js';

export { DEFAULT_RECONCILE_LIMIT, reconcileEnrichment } from './application/reconcile.js';
export type { ReconcileOptions, ReconcileReport } from './application/reconcile.js';

export { queueLagSnapshot } from './application/lag.js';
export type { QueueLagSnapshot } from './application/lag.js';

export { ReflectionNotStoredError } from './application/errors.js';
export type { ReflectionFailureStage } from './application/errors.js';

export { ReflectionDispatch } from './application/dispatch.js';
export type {
  ReflectionDispatchOptions,
  ReflectionJobListener,
  ReflectionJobSignal,
} from './application/dispatch.js';

export {
  mergeStageCounts,
  shouldMarkApplied,
  stageLedgerKey,
  summarizeRun,
} from './domain/stage.js';
export type {
  ReflectionStage,
  ReflectionSummary,
  StageContext,
  StageCounts,
  StageOutcome,
  StageRecord,
  StageStatus,
} from './domain/stage.js';

export { ReflectionOrchestrator, orchestratorLedgerKey } from './application/orchestrator.js';
export type {
  ReflectionOrchestratorDeps,
  ReflectionRun,
  ReflectionRunOptions,
  ReflectionRunStatus,
} from './application/orchestrator.js';

export {
  DEFAULT_BREAKER_COOLDOWN_MS,
  DEFAULT_BREAKER_THRESHOLD,
  DEFAULT_DRAIN_STALE_TIMEOUT_MS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_RETRY_BASE_MS,
  DEFAULT_RETRY_CAP_MS,
  DEFAULT_VECTOR_BATCH_SIZE,
  DEFAULT_WORKER_COUNT,
  ReflectionWorker,
  backoffDelayMs,
} from './application/worker.js';
export type {
  ReflectionDrain,
  ReflectionRunner,
  ReflectionWorkerDeps,
  ReflectionWorkerOptions,
} from './application/worker.js';

export { attachContentVectors, findPendingVectorNodes } from './application/vectors.js';
export type { PendingVectorNode } from './application/vectors.js';

export { ENTITY_EXTRACTION_METHOD, EntityExtractionStage } from './application/stages/entities.js';
export type { EntityStageOptions } from './application/stages/entities.js';

export { ENTITY_DEDUP_METHOD, EntityDedupStage } from './application/stages/entity-dedup.js';
export type { EntityDedupStageOptions } from './application/stages/entity-dedup.js';

export { AssociationInferenceStage } from './application/stages/associations.js';
export type { AssociationStageOptions } from './application/stages/associations.js';

export { CognitiveExtractionStage } from './application/stages/cognitive.js';
export type { CognitiveExtractionStageOptions } from './application/stages/cognitive.js';

export { SemanticRelationshipStage } from './application/stages/semantic-relationships.js';
export type { SemanticRelationshipStageOptions } from './application/stages/semantic-relationships.js';

export { judgeContradiction, SupersessionStage } from './application/stages/supersession.js';
export type {
  ContradictionJudgment,
  ContradictionPair,
  JudgeContradictionOptions,
  JudgeOutcome,
  SupersessionMode,
  SupersessionStageOptions,
} from './application/stages/supersession.js';

export {
  REFLECTION_CO_EXTRACTION_TRIGGER,
  ReinforcementEnqueueStage,
} from './application/stages/reinforcement.js';

export { ContextVectorStage } from './application/stages/context-vectors.js';

export {
  NARRATIVE_EXTRACTION_METHOD,
  NARRATIVE_STAGE_NAME,
  SessionNarrativeCloser,
  SessionNarrativeStage,
  closeSessionNarrative,
  sweepIdleSessions,
} from './application/narratives.js';
export type {
  IdleSweepOptions,
  NarrativeDeps,
  NarrativeOptions,
  NarrativeResult,
  NarrativeStatus,
  SessionNarrativeOptions,
} from './application/narratives.js';

export { IdleNarrativeSweeper, sweepIntervalMs } from './application/narrative-sweeper.js';
export type { IdleNarrativeSweeperOptions } from './application/narrative-sweeper.js';

export {
  hashContent,
  prepareEpisode,
  renderEpisodeText,
  stableStringify,
} from './domain/content.js';
export type { PreparedEpisode, PreparedTurn, ReflectionContent } from './domain/content.js';

export {
  MIN_OVERLAP_NAME_LENGTH,
  NAME_FORM_OVERLAP_THRESHOLD,
  nameFormMatches,
  nameFormOverlap,
} from './domain/entity-identity.js';

export {
  applySupersessionProposal,
  DEFAULT_APPLY_SCOPE,
  dismissSupersessionProposal,
  ProposalAlreadyResolvedError,
  ProposalNotFoundError,
  PROPOSAL_APPLY_METHOD,
} from './application/proposals.js';
export type {
  ApplyProposalInput,
  ApplyProposalResult,
  ApplyScope,
} from './application/proposals.js';
