/**
 * The introspection layer's public surface: the health snapshot, the decision engine, the
 * operation contract every maintenance operation implements, and the loop that runs them.
 */

export { OPERATION_BUCKETS, bucketStamp, operationBucketKey, OPERATION_LEDGER_PREFIX } from './domain/buckets.js';
export type { OperationBucket } from './domain/buckets.js';

export {
  CRITICAL_MIN_POPULATION,
  CRITICAL_ORPHAN_SHARE,
  CRITICAL_VECTOR_PARITY,
  DEPRIORITIZED_WEIGHT,
  criticalConditions,
  decide,
  scoreCandidate,
  starvationBoost,
} from './domain/decide.js';
export type {
  CriticalCondition,
  Decision,
  DecisionInput,
  OperationCandidate,
  ScoredCandidate,
} from './domain/decide.js';

export {
  HEALTH_COLLECTORS,
  NEUTRAL_ENRICHMENT_HEALTH,
  NEUTRAL_GRAPH_HEALTH,
  NEUTRAL_PLASTICITY_HEALTH,
  NEUTRAL_PROPOSAL_HEALTH,
  NEUTRAL_QUEUE_HEALTH,
  NEUTRAL_REDACTION_HEALTH,
  neutralSnapshot,
  parityRatio,
  share,
} from './domain/health.js';
export type {
  EnrichmentHealth,
  GraphStructureHealth,
  HealthCollector,
  HealthSnapshot,
  OperationEffectiveness,
  PlasticityHealth,
  ProposalHealth,
  QueueHealth,
  RedactionHealth,
} from './domain/health.js';

export { measureImproved, operationImprovement } from './domain/operation.js';
export type {
  IntrospectionOperation,
  OperationContext,
  OperationOutcome,
  OperationStatus,
  OperationTier,
} from './domain/operation.js';

export { proposeOnlyAdvisor } from './domain/tier3.js';
export type { Tier3Advisor, Tier3Proposal, Tier3Request } from './domain/tier3.js';

export {
  DEFAULT_OBSERVE_RESIDUE_LIMIT,
  DEFAULT_OBSERVE_SCAN_LIMIT,
  observeHealth,
  readOperationEffectiveness,
} from './application/observe.js';
export type { ObserveDeps, ObserveOptions } from './application/observe.js';

export { DEFAULT_TICK_JITTER, Introspector, MAX_BACKOFF_FACTOR } from './application/engine.js';
export type { IntrospectorDeps, IntrospectorOptions, TickReport } from './application/engine.js';

export { introspectionOperations } from './application/catalog.js';

export {
  DECAY_STANDING_RELEVANCE,
  MEMORY_DECAY_OPERATION,
  REINFORCEMENT_FLUSH_OPERATION,
  memoryDecayOperation,
  reinforcementFlushOperation,
  reinforcementFlushRelevance,
} from './application/plasticity-operations.js';

export {
  DEAD_LETTER_OPERATION,
  deadLetterOperation,
  deadLetterRelevance,
} from './application/operations/dead-letter.js';
export {
  RECONCILE_REENQUEUE_OPERATION,
  reconcileReenqueueOperation,
  reconcileReenqueueRelevance,
} from './application/operations/reconcile-reenqueue.js';
export {
  REDACTION_RESIDUE_PURGE_OPERATION,
  redactionResiduePurgeOperation,
  redactionResiduePurgeRelevance,
} from './application/operations/redaction-residue-purge.js';
export {
  VECTOR_BACKFILL_OPERATION,
  vectorBackfillOperation,
  vectorBackfillRelevance,
} from './application/operations/vector-backfill.js';

export {
  DESCRIPTION_FRESHNESS_OPERATION,
  DESCRIPTION_FRESHNESS_STANDING_RELEVANCE,
  descriptionFreshnessOperation,
} from './application/operations/description-freshness-operation.js';
export type { DescriptionFreshnessOverrides } from './application/operations/description-freshness-operation.js';
export {
  NARRATIVE_CLEANUP_OPERATION,
  NARRATIVE_CLEANUP_STANDING_RELEVANCE,
  NARRATIVE_DUPLICATE_METHOD,
  narrativeCleanupOperation,
} from './application/operations/narrative-cleanup-operation.js';
export {
  RETRO_JUDGMENT_SWEEP_OPERATION,
  RETRO_SWEEP_STANDING_RELEVANCE,
  retroJudgmentSweepOperation,
} from './application/operations/retro-judgment-sweep-operation.js';
export type { RetroJudgmentSweepOverrides } from './application/operations/retro-judgment-sweep-operation.js';
export type { ProviderFactory } from './application/operations/routed-generation.js';

export {
  COMMUNITY_REFRESH_OPERATION,
  COMMUNITY_REFRESH_RELEVANCE,
  communityRefreshOperation,
  communityRefreshRelevance,
} from './application/operations/community-refresh.js';
export {
  ORPHAN_CLEANUP_OPERATION,
  ORPHAN_RELINK_CONFIDENCE,
  ORPHAN_RELINK_PROVENANCE,
  ORPHAN_RELINK_SIGNAL,
  ORPHAN_RELINK_STRENGTH,
  orphanCleanupOperation,
  orphanCleanupRelevance,
} from './application/operations/orphan-cleanup.js';
export {
  BRIDGE_CANDIDATE_LIMIT,
  SYMBIOSIS_BRIDGE_OPERATION,
  SYMBIOSIS_BRIDGE_RELEVANCE,
  symbiosisBridgeOperation,
  symbiosisBridgeRelevance,
} from './application/operations/symbiosis-bridge.js';
export type {
  BridgeEmbedder,
  SymbiosisBridgeOptions,
} from './application/operations/symbiosis-bridge.js';

/**
 * The repair the loop never selects on its own. It is exported beside the catalog because it
 * has the same shape as an operation and belongs to the same layer; what it does not have is a
 * measurable trigger, so a person names the merge to reverse.
 */
export {
  ENTITY_UNMERGE_OPERATION,
  entityUnmergeLedgerKey,
  listUnmergeableRecords,
  runEntityUnmerge,
} from './application/operations/unmerge.js';
export type {
  UnmergeDeps,
  UnmergeReport,
  UnmergeRequest,
} from './application/operations/unmerge.js';
