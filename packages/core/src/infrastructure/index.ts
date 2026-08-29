/**
 * The infrastructure layer's public surface: config, graph, providers, SQLite, logging.
 * Split out of the package entrypoint to keep every file under the repo's line cap; the
 * entrypoint re-exports this verbatim, so `@aion/core` is unchanged by the split.
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
  listLedgerKeys,
  markLedgerApplied,
} from './sqlite/ops-ledger.js';
export type { OpsLedgerEntry } from './sqlite/ops-ledger.js';

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

export {
  MANAGED_NEO4J_URI,
  NEO4J_DEFAULT_USER,
  Neo4jGdsUnavailableError,
  Neo4jNotReadyError,
  ensureNeo4jPassword,
  generateStrongPassword,
  isManagedNeo4jUri,
  validateNeo4jEndpoint,
  verifyGdsAvailable,
  waitForBoltReady,
} from './graph/provision.js';
export type { Neo4jEndpoint, ReadinessOptions } from './graph/provision.js';

export {
  GRAPH_MIGRATIONS,
  graphMigrationMetaKey,
  latestAppliedGraphMigration,
  runGraphMigrations,
} from './graph/migrations.js';
export type { GraphMigration, GraphMigrationOutcome, MigrationContext } from './graph/migrations.js';

export { GraphConnection, GraphTransaction, inWriteTransaction, runRead, runWrite, runWriteWithCounters } from './graph/connection.js';
export type { GraphHealth, GraphStatement, WriteOutcome } from './graph/connection.js';

export {
  GraphNodeNotFoundError,
  GraphWriteError,
  VectorIndexDimensionMismatchError,
  VectorIndexMissingError,
  isGraphUnavailable,
} from './graph/errors.js';

export {
  VECTOR_INDEX_NAMES,
  assertVectorIndexDimensions,
  countGraphElements,
  readStoredText,
  readVectorIndexes,
} from './graph/introspection.js';
export type { GraphCounts, VectorIndexInfo } from './graph/introspection.js';

export { BASE_NODE_LABEL, NODE_LABELS, isContentBearing, isNodeLabel, resolveLabels } from './graph/labels.js';
export type { NodeLabel } from './graph/labels.js';

export {
  DIRECTED_RELATIONSHIP_TYPES,
  RELATIONSHIP_TYPES,
  SUPERSEDES_TYPE,
  UNDIRECTED_RELATIONSHIP_TYPES,
  isRelationshipType,
  isUndirectedRelationshipType,
  normalizeEndpoints,
} from './graph/relationships.js';
export type {
  DirectedRelationshipType,
  Endpoints,
  RelationshipType,
  UndirectedRelationshipType,
} from './graph/relationships.js';

export {
  coerceGraphValue,
  coerceRow,
  fromGraphDateTime,
  fromGraphVector,
  identityRow,
  toGraphDateTime,
  toGraphParameters,
  toGraphVector,
} from './graph/values.js';
export type { GraphProperties, GraphWritable, Row, RowMapper } from './graph/values.js';

export { buildEdgeUpsert, upsertEdge, upsertEdgeInTransaction } from './graph/edges.js';
export type { EdgeUpsert, UpsertedEdge } from './graph/edges.js';

export {
  buildEdgeWeightDecay,
  buildEdgeWeightReinforcement,
  decayEdgeWeights,
  reinforceEdgeWeights,
} from './graph/edge-weights.js';
export type {
  DecayedEdge,
  ReinforceEdgeWeightsInput,
  ReinforcedEdge,
  WeightDecayInput,
  WeightReinforcement,
} from './graph/edge-weights.js';

export {
  PROTECTED_RELATIONSHIP_TYPES,
  isProtectedRelationshipType,
} from './graph/protected-relationships.js';

export { LOCK_PROPERTY, lockNodeInTransaction } from './graph/locks.js';

export {
  BITEMPORAL_PROPERTIES,
  buildStampedNodeWrite,
  stampNew,
  supersede,
  writeStampedNode,
  writeStampedNodeInTransaction,
} from './graph/bitemporal.js';
export type {
  StampNewInput,
  StampedNode,
  StampedNodeResult,
  StampedNodeWrite,
  SupersedeInput,
  SupersedeResult,
} from './graph/bitemporal.js';

export {
  EPISODE_PROPAGATION_METHOD,
  propagateEpisodeSupersession,
  findSourceEpisodeId,
  supersedeEpisode,
} from './graph/episode-supersession.js';
export type {
  EpisodePropagationResult,
  SupersedeEpisodeInput,
  SupersedeEpisodeResult,
} from './graph/episode-supersession.js';

export { bootstrapBackbone, GLOBAL_WORKSPACE_NAME, readMemberName } from './graph/backbone.js';
export type { BootstrapBackboneInput, BootstrapBackboneResult } from './graph/backbone.js';

export {
  CONTAINMENT_TYPE,
  MEMORY_PROPERTIES,
  findEpisodeByContentHash,
  findEpisodeByContentHashInTransaction,
  listSessionEpisodeIds,
  listStoredEpisodes,
} from './graph/episodes.js';
export type {
  FindEpisodeByContentHashInput,
  StoredEpisodeRef,
} from './graph/episodes.js';

export { ensureGraphSession } from './graph/sessions.js';
export type { EnsureGraphSessionInput, EnsureGraphSessionResult } from './graph/sessions.js';

export {
  asOf,
  bitemporalAt,
  isTimeTravel,
  knewAt,
  readCurrencyAnnotation,
  readModeFragment,
  withCurrency,
} from './graph/read-modes.js';
export type {
  Currency,
  CurrencyAnnotation,
  ReadFragment,
  ReadMode,
  SupersededBy,
} from './graph/read-modes.js';

export type { ChatMessage, ChatRole, JsonSchema, Provider, StructuredRequest, Vector } from './providers/types.js';
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
export { checkOllamaReachable, listOllamaModels, provisionOllama } from './providers/provisioning.js';
export type { OllamaProvisionTarget, ProvisionEvent, ProvisionOptions } from './providers/provisioning.js';

export { loadEpisodeContext } from './graph/episode-context.js';
export type { EpisodeContext, EpisodeTurnContext } from './graph/episode-context.js';

export {
  DERIVES_FROM_TYPE,
  NARRATIVE_PROPERTIES,
  SUMMARIZED_BY_TYPE,
  findIdleSessions,
  findSessionNarratives,
  loadSessionEpisodes,
} from './graph/narrative-queries.js';
export type { IdleSession, SessionEpisode, SessionNarrative } from './graph/narrative-queries.js';

export {
  COGNITIVE_NODE_LABELS,
  deriveCognitiveNodeId,
  isCognitiveNodeLabel,
  normalizeCognitiveText,
} from './graph/cognitive-queries.js';
export type { CognitiveNodeLabel } from './graph/cognitive-queries.js';

export {
  ENTITY_MENTION_TYPE,
  ENTITY_PARTICIPATION_TYPE,
  findEpisodeEntities,
} from './graph/entity-queries.js';
export type { EpisodeEntity } from './graph/entity-queries.js';

export { CO_OCCURS_TYPE, SIMILAR_TYPE } from './graph/association-queries.js';

export {
  SEMANTIC_RELATIONSHIP_METHOD,
  SEMANTIC_RELATIONSHIP_TYPES,
  findEpisodeCognitiveNodes,
  isSemanticRelationshipType,
} from './graph/semantic-relationship-queries.js';
export type {
  EpisodeCognitiveNode,
  SemanticRelationshipType,
} from './graph/semantic-relationship-queries.js';

export { CONTEXT_VECTOR_PROPERTY } from './graph/context-vector-queries.js';

export {
  findSupersessionProposalsForNode,
  getSupersessionProposal,
  countOpenSupersessionProposals,
  listSupersessionProposals,
  recordSupersessionProposal,
  resolveSupersessionProposal,
} from './sqlite/supersession-proposals.js';
export type { SupersessionProposal } from './sqlite/supersession-proposals.js';

export { buildAdjacencyStatement, fetchAdjacency } from './graph/adjacency.js';
export type { AdjacencyNeighbor, AdjacencyRequest } from './graph/adjacency.js';

export {
  CONTENT_FULLTEXT_INDEX,
  CONTENT_VECTOR_INDEX,
  EXACT_NAME_MATCH_SCORE,
  LAST_ACCESSED_PROPERTY,
  contentVectors,
  entityNameSeeds,
  entitySimilaritySeeds,
  escapeLuceneQuery,
  fulltextSeeds,
  lucenePhraseQuery,
  nodeCandidates,
  normalizeSeedName,
  recencySeeds,
  vectorSeeds,
} from './graph/seed-queries.js';
export type {
  EntityNameMatch,
  NodeContentVector,
  NodesByIdInput,
  ScoredSeedCandidate,
  SeedCandidate,
} from './graph/seed-queries.js';

export {
  ACCESS_COUNT_PROPERTY,
  buildRecordAccessStatement,
  recordAccess,
} from './graph/access-tracking.js';
export type { RecordAccessInput } from './graph/access-tracking.js';

export { foldForIdentity, foldName } from './providers/unicode-fold.js';

export { MERGE_PROVENANCE_PROPERTY } from './graph/entity-dedup-queries.js';
export type { MergedEntityRecord } from './graph/entity-dedup-queries.js';

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

export { PACK_METHODS, packMethodCounters, recordPackMethodCounts } from './sqlite/method-counters.js';
export type { PackMethod, PackMethodCounters } from './sqlite/method-counters.js';

export {
  buildEdgeWeightDistribution,
  EDGE_WEIGHT_DISTRIBUTION_TYPES,
  edgeWeightDistribution,
} from './graph/edge-weight-distribution.js';
export type {
  EdgeWeightDistribution,
  EdgeWeightDistributionType,
  EdgeWeightStats,
} from './graph/edge-weight-distribution.js';

