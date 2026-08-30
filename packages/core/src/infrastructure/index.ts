/**
 * The infrastructure layer's public surface: config, providers, SQLite, logging, and the graph
 * through `graph-index.ts`. Split out of the package entrypoint, and split again once the
 * graph half alone passed the repo's line cap; the entrypoint re-exports this verbatim, so
 * `@aion/core` is unchanged by either split.
 */

export {
  DEFAULT_LOG_FILE,
  DEFAULT_LOG_LEVEL,
  LOG_FILE_ENV_VAR,
  LOG_LEVEL_ENV_VAR,
  LOG_LEVELS,
  openLogger,
} from './logging/logger.js';
export type { LogLevel, LogTarget, Logger } from './logging/logger.js';

export {
  DEFAULT_BUSY_TIMEOUT_MS,
  DEFAULT_SQLITE_PATH,
  SQLITE_PATH_ENV_VAR,
  SqliteStore,
  openSqliteHandle,
} from './sqlite/database.js';
export type { SqliteHandle, SqliteTarget } from './sqlite/database.js';

export { getMeta, setMeta } from './sqlite/meta.js';

export {
  getLedgerEntry,
  isLedgerApplied,
  latestLedgerEntry,
  listLedgerKeys,
  markLedgerApplied,
} from './sqlite/ops-ledger.js';
export type { OpsLedgerEntry } from './sqlite/ops-ledger.js';

export {
  claimOperationBucket,
  clearPendingMeasure,
  introspectionCycle,
  listOperationStats,
  nextIntrospectionCycle,
  operationStats,
  recordOperationResolution,
  recordOperationRun,
  recordOperationSelected,
  setPendingMeasure,
} from './sqlite/introspection-counters.js';
export type { OperationResolution, OperationStats } from './sqlite/introspection-counters.js';

export {
  DEFAULT_REFLECTION_LANE,
  REFLECTION_LANES,
  enqueueReflectionJob,
  findPendingReflectionJob,
  getReflectionJob,
  isReflectionLane,
  listReflectionJobs,
  toReflectionLane,
} from './sqlite/reflection-queue.js';
export type {
  EnqueueReflectionJobOptions,
  ReflectionJob,
  ReflectionLane,
} from './sqlite/reflection-queue.js';

export {
  countQueueJobs,
  countQueueJobsByLane,
  dropUnclaimedJobs,
  listQueueJobs,
  promoteJobs,
} from './sqlite/reflection-queue-admin.js';
export type {
  ReflectionQueueCounts,
  ReflectionQueueFilter,
} from './sqlite/reflection-queue-admin.js';

export {
  DEFAULT_STALE_CLAIM_TIMEOUT_MS,
  ReflectionQueueClaimant,
  reclaimStaleReflectionJobs,
} from './sqlite/claim.js';

export {
  DEFAULT_REINFORCEMENT_QUEUE_CAP,
  claimReinforcementSignals,
  countReinforcementSignals,
  deleteReinforcementSignals,
  enqueueReinforcementSignal,
  listReinforcementSignals,
  recordReinforcementFlush,
  reinforcementFlushCounters,
  reinforcementQueueDroppedCount,
} from './sqlite/reinforcement-queue.js';
export type {
  ReinforcementFlushCounters,
  ReinforcementFlushCounts,
  ReinforcementSignal,
} from './sqlite/reinforcement-queue.js';

export { decaySweepCounters, recordDecaySweep } from './sqlite/decay-counters.js';
export type { DecaySweepCounters, DecaySweepCounts } from './sqlite/decay-counters.js';

export {
  DEFAULT_LAG_SAMPLE_WINDOW,
  listEnrichmentLagSamplesMs,
  p95EnrichmentLagMs,
  recordEnrichmentLagMs,
} from './sqlite/lag-samples.js';

export { getLastPack, listLastPackSessions, saveLastPack } from './sqlite/last-pack.js';
export type { LastPack, LastPackSession } from './sqlite/last-pack.js';

export {
  ConfigSchema,
  DEFAULTS,
  KNOB_REGISTRY,
  RESERVED_ENV_VARS,
  knownEnvVars,
  envVarForPath,
  loadConfig,
  ConfigError,
} from './config/index.js';
export type { Config, Knob, KnobKind, ConfigPath } from './config/index.js';

export * from './graph-index.js';

export type {
  ChatMessage,
  ChatRole,
  GenerationBackend,
  JsonSchema,
  Provider,
  StructuredRequest,
  Vector,
} from './providers/types.js';
export {
  AnthropicProvider,
  AnthropicRequestError,
  AnthropicResponseError,
  DEFAULT_ANTHROPIC_MODEL,
} from './providers/anthropic-provider.js';
export type { AnthropicProviderOptions, SchemaDelivery } from './providers/anthropic-provider.js';
export {
  GENERATION_ROLES,
  evictableModels,
  localChatModels,
  modelsToPull,
  remoteBannerLines,
  remoteRoutes,
  resolveProviderRouting,
  routeFor,
  routingSummary,
  unbackedPins,
} from './providers/routing.js';
export type {
  GenerationRole,
  ProviderName,
  ProviderPin,
  ProviderRouting,
  RoleRoute,
  RouteReason,
} from './providers/routing.js';
export { ProviderRouter } from './providers/role-provider.js';
export type { GenerationEvent, ProviderRouterOptions } from './providers/role-provider.js';
export { listResidentModels, reconcileResidentModels } from './providers/model-reconciliation.js';
export type {
  ReconciliationOptions,
  ReconciliationReport,
  ResidentModel,
} from './providers/model-reconciliation.js';
export {
  EmbedDimensionMismatchError,
  ModelPullError,
  ModelVerificationError,
  OllamaUnreachableError,
} from './providers/errors.js';
export { CircuitBreaker, CircuitOpenError } from './providers/circuit-breaker.js';
export type { CircuitBreakerOptions } from './providers/circuit-breaker.js';
export { OllamaProvider } from './providers/ollama-provider.js';
export type { OllamaProviderOptions } from './providers/ollama-provider.js';
export {
  checkOllamaReachable,
  listOllamaModels,
  provisionOllama,
  verifyOllamaChatModel,
} from './providers/provisioning.js';
export type {
  OllamaProvisionTarget,
  ProvisionEvent,
  ProvisionOptions,
} from './providers/provisioning.js';

export {
  findSupersessionProposalsForNode,
  getSupersessionProposal,
  countOpenSupersessionProposals,
  listSupersessionProposals,
  recordSupersessionProposal,
  resolveSupersessionProposal,
} from './sqlite/supersession-proposals.js';
export type { SupersessionProposal } from './sqlite/supersession-proposals.js';

export { foldForIdentity, foldName } from './providers/unicode-fold.js';

export {
  findEntityMergeProposalsForNode,
  getEntityMergeProposal,
  countOpenEntityMergeProposals,
  listEntityMergeProposals,
  recordEntityMergeProposal,
  resolveEntityMergeProposal,
} from './sqlite/entity-merge-proposals.js';
export type {
  EntityMergeProposal,
  EntityMergeProposalInput,
  EntityMergeProposalSide,
} from './sqlite/entity-merge-proposals.js';

export {
  cueDegradedRate,
  DEFAULT_RECALL_SAMPLE_WINDOW,
  recordCueOutcome,
} from './sqlite/recall-samples.js';

export {
  PACK_METHODS,
  packMethodCounters,
  recordPackMethodCounts,
} from './sqlite/method-counters.js';
export type { PackMethod, PackMethodCounters } from './sqlite/method-counters.js';

export { recallCadenceCounters, recordRecallOutcome } from './sqlite/recall-cadence.js';
export type { RecallCadenceCounters, RecallOutcome } from './sqlite/recall-cadence.js';
