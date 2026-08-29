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
