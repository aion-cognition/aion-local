export {
  DEFAULT_LOG_FILE,
  DEFAULT_LOG_LEVEL,
  LOG_FILE_ENV_VAR,
  LOG_LEVEL_ENV_VAR,
  LOG_LEVELS,
  openLogger,
} from './infrastructure/logging/logger.js';
export type { LogLevel, LogTarget, Logger } from './infrastructure/logging/logger.js';

export {
  DEFAULT_BUSY_TIMEOUT_MS,
  DEFAULT_SQLITE_PATH,
  SQLITE_PATH_ENV_VAR,
  SqliteStore,
  openSqliteHandle,
} from './infrastructure/sqlite/database.js';
export type { SqliteHandle, SqliteTarget } from './infrastructure/sqlite/database.js';

export { getMeta, setMeta } from './infrastructure/sqlite/meta.js';

export {
  getLedgerEntry,
  isLedgerApplied,
  listLedgerKeys,
  markLedgerApplied,
} from './infrastructure/sqlite/ops-ledger.js';
export type { OpsLedgerEntry } from './infrastructure/sqlite/ops-ledger.js';

export {
  DEFAULT_REFLECTION_LANE,
  REFLECTION_LANES,
  enqueueReflectionJob,
  findPendingReflectionJob,
  getReflectionJob,
  isReflectionLane,
  listReflectionJobs,
  toReflectionLane,
} from './infrastructure/sqlite/reflection-queue.js';
export type {
  EnqueueReflectionJobOptions,
  ReflectionJob,
  ReflectionLane,
} from './infrastructure/sqlite/reflection-queue.js';

export {
  countQueueJobs,
  countQueueJobsByLane,
  dropUnclaimedJobs,
  listQueueJobs,
  promoteJobs,
} from './infrastructure/sqlite/reflection-queue-admin.js';
export type {
  ReflectionQueueCounts,
  ReflectionQueueFilter,
} from './infrastructure/sqlite/reflection-queue-admin.js';

export {
  DEFAULT_STALE_CLAIM_TIMEOUT_MS,
  ReflectionQueueClaimant,
  reclaimStaleReflectionJobs,
} from './infrastructure/sqlite/claim.js';

export {
  DEFAULT_REINFORCEMENT_QUEUE_CAP,
  enqueueReinforcementSignal,
  listReinforcementSignals,
  reinforcementQueueDroppedCount,
} from './infrastructure/sqlite/reinforcement-queue.js';
export type { ReinforcementSignal } from './infrastructure/sqlite/reinforcement-queue.js';

export {
  DEFAULT_LAG_SAMPLE_WINDOW,
  listEnrichmentLagSamplesMs,
  p95EnrichmentLagMs,
  recordEnrichmentLagMs,
} from './infrastructure/sqlite/lag-samples.js';

export { getLastPack, listLastPackSessions, saveLastPack } from './infrastructure/sqlite/last-pack.js';
export type { LastPack, LastPackSession } from './infrastructure/sqlite/last-pack.js';

export {
  ConfigSchema,
  DEFAULTS,
  KNOB_REGISTRY,
  RESERVED_ENV_VARS,
  knownEnvVars,
  envVarForPath,
  loadConfig,
  ConfigError,
} from './infrastructure/config/index.js';
export type { Config, Knob, KnobKind, ConfigPath } from './infrastructure/config/index.js';

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
} from './infrastructure/graph/provision.js';
export type { Neo4jEndpoint, ReadinessOptions } from './infrastructure/graph/provision.js';

export {
  GRAPH_MIGRATIONS,
  graphMigrationMetaKey,
  latestAppliedGraphMigration,
  runGraphMigrations,
} from './infrastructure/graph/migrations.js';
export type { GraphMigration, GraphMigrationOutcome, MigrationContext } from './infrastructure/graph/migrations.js';

export { GraphConnection, GraphTransaction, inWriteTransaction, runRead, runWrite, runWriteWithCounters } from './infrastructure/graph/connection.js';
export type { GraphHealth, GraphStatement, WriteOutcome } from './infrastructure/graph/connection.js';

export {
  GraphNodeNotFoundError,
  GraphWriteError,
  VectorIndexDimensionMismatchError,
  VectorIndexMissingError,
  isGraphUnavailable,
} from './infrastructure/graph/errors.js';

export {
  VECTOR_INDEX_NAMES,
  assertVectorIndexDimensions,
  countGraphElements,
  readVectorIndexes,
} from './infrastructure/graph/introspection.js';
export type { GraphCounts, VectorIndexInfo } from './infrastructure/graph/introspection.js';

export { BASE_NODE_LABEL, NODE_LABELS, isContentBearing, isNodeLabel, resolveLabels } from './infrastructure/graph/labels.js';
export type { NodeLabel } from './infrastructure/graph/labels.js';

export {
  DIRECTED_RELATIONSHIP_TYPES,
  RELATIONSHIP_TYPES,
  SUPERSEDES_TYPE,
  UNDIRECTED_RELATIONSHIP_TYPES,
  isRelationshipType,
  isUndirectedRelationshipType,
  normalizeEndpoints,
} from './infrastructure/graph/relationships.js';
export type {
  DirectedRelationshipType,
  Endpoints,
  RelationshipType,
  UndirectedRelationshipType,
} from './infrastructure/graph/relationships.js';

export {
  coerceGraphValue,
  coerceRow,
  fromGraphDateTime,
  fromGraphVector,
  identityRow,
  toGraphDateTime,
  toGraphParameters,
  toGraphVector,
} from './infrastructure/graph/values.js';
export type { GraphProperties, GraphWritable, Row, RowMapper } from './infrastructure/graph/values.js';

export { buildEdgeUpsert, upsertEdge, upsertEdgeInTransaction } from './infrastructure/graph/edges.js';
export type { EdgeUpsert, UpsertedEdge } from './infrastructure/graph/edges.js';

export { LOCK_PROPERTY, lockNodeInTransaction } from './infrastructure/graph/locks.js';

export {
  BITEMPORAL_PROPERTIES,
  buildStampedNodeWrite,
  stampNew,
  supersede,
  writeStampedNode,
  writeStampedNodeInTransaction,
} from './infrastructure/graph/bitemporal.js';
export type {
  StampNewInput,
  StampedNode,
  StampedNodeResult,
  StampedNodeWrite,
  SupersedeInput,
  SupersedeResult,
} from './infrastructure/graph/bitemporal.js';

export {
  EPISODE_PROPAGATION_METHOD,
  propagateEpisodeSupersession,
  supersedeEpisode,
} from './infrastructure/graph/episode-supersession.js';
export type {
  EpisodePropagationResult,
  SupersedeEpisodeInput,
  SupersedeEpisodeResult,
} from './infrastructure/graph/episode-supersession.js';

export { bootstrapBackbone, GLOBAL_WORKSPACE_NAME, readMemberName } from './infrastructure/graph/backbone.js';
export type { BootstrapBackboneInput, BootstrapBackboneResult } from './infrastructure/graph/backbone.js';

export {
  CONTAINMENT_TYPE,
  MEMORY_PROPERTIES,
  findEpisodeByContentHash,
  findEpisodeByContentHashInTransaction,
  listSessionEpisodeIds,
  listStoredEpisodes,
} from './infrastructure/graph/episodes.js';
export type {
  FindEpisodeByContentHashInput,
  StoredEpisodeRef,
} from './infrastructure/graph/episodes.js';

export { ensureGraphSession } from './infrastructure/graph/sessions.js';
export type { EnsureGraphSessionInput, EnsureGraphSessionResult } from './infrastructure/graph/sessions.js';

export {
  asOf,
  bitemporalAt,
  isTimeTravel,
  knewAt,
  readCurrencyAnnotation,
  readModeFragment,
  withCurrency,
} from './infrastructure/graph/read-modes.js';
export type {
  Currency,
  CurrencyAnnotation,
  ReadFragment,
  ReadMode,
  SupersededBy,
} from './infrastructure/graph/read-modes.js';

export type { ChatMessage, ChatRole, JsonSchema, Provider, StructuredRequest, Vector } from './infrastructure/providers/types.js';
export {
  EmbedDimensionMismatchError,
  ModelPullError,
  ModelVerificationError,
  OllamaUnreachableError,
} from './infrastructure/providers/errors.js';
export { CircuitBreaker, CircuitOpenError } from './infrastructure/providers/circuit-breaker.js';
export type { CircuitBreakerOptions } from './infrastructure/providers/circuit-breaker.js';
export { OllamaProvider } from './infrastructure/providers/ollama-provider.js';
export type { OllamaProviderOptions } from './infrastructure/providers/ollama-provider.js';
export { checkOllamaReachable, listOllamaModels, provisionOllama } from './infrastructure/providers/provisioning.js';
export type { OllamaProvisionTarget, ProvisionEvent, ProvisionOptions } from './infrastructure/providers/provisioning.js';

export { DEFAULT_ENTROPY_THRESHOLD, redact } from './redaction/redact.js';
export type { RedactionMatch, RedactionResult } from './redaction/redact.js';
export { redactPayload } from './redaction/deep-walk.js';
export type { DeepRedactionResult } from './redaction/deep-walk.js';
export { HIGH_ENTROPY_RULE_ID, REDACTION_RULES, REDACTION_RULE_IDS } from './redaction/rules.js';
export type { RedactionRule } from './redaction/rules.js';
export { buildFingerprint } from './redaction/fingerprint.js';
export { findHighEntropyTokens, shannonEntropy } from './redaction/entropy.js';
export type { TextSpan } from './redaction/entropy.js';

export { SessionManager } from './session/session-manager.js';
export type {
  EnsureSessionInput,
  EnsureSessionResult,
  SessionManagerBackbone,
} from './session/session-manager.js';

export {
  INTAKE_EXTRACTION_METHOD,
  INTEGRATE_JOB_TYPE,
  handleReflection,
} from './reflection/application/intake.js';
export type { ReflectionIntakeDeps, ReflectionIntakeOptions } from './reflection/application/intake.js';

export { LaneAssigner } from './reflection/application/lanes.js';
export type { LaneAssignerOptions, LaneDecision, LaneRequest } from './reflection/application/lanes.js';

export { DEFAULT_RECONCILE_LIMIT, reconcileEnrichment } from './reflection/application/reconcile.js';
export type { ReconcileOptions, ReconcileReport } from './reflection/application/reconcile.js';

export { queueLagSnapshot } from './reflection/application/lag.js';
export type { QueueLagSnapshot } from './reflection/application/lag.js';

export { ReflectionNotStoredError } from './reflection/application/errors.js';
export type { ReflectionFailureStage } from './reflection/application/errors.js';

export { ReflectionDispatch } from './reflection/application/dispatch.js';
export type {
  ReflectionDispatchOptions,
  ReflectionJobListener,
  ReflectionJobSignal,
} from './reflection/application/dispatch.js';

export {
  mergeStageCounts,
  shouldMarkApplied,
  stageLedgerKey,
  summarizeRun,
} from './reflection/domain/stage.js';
export type {
  ReflectionStage,
  ReflectionSummary,
  StageContext,
  StageCounts,
  StageOutcome,
  StageRecord,
  StageStatus,
} from './reflection/domain/stage.js';

export { ReflectionOrchestrator, orchestratorLedgerKey } from './reflection/application/orchestrator.js';
export type {
  ReflectionOrchestratorDeps,
  ReflectionRun,
  ReflectionRunOptions,
  ReflectionRunStatus,
} from './reflection/application/orchestrator.js';

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
} from './reflection/application/worker.js';
export type {
  ReflectionDrain,
  ReflectionRunner,
  ReflectionWorkerDeps,
  ReflectionWorkerOptions,
} from './reflection/application/worker.js';

export { attachContentVectors, findPendingVectorNodes } from './reflection/application/vectors.js';
export type { PendingVectorNode } from './reflection/application/vectors.js';

export {
  ENTITY_EXTRACTION_METHOD,
  EntityExtractionStage,
} from './reflection/application/stages/entities.js';
export type { EntityStageOptions } from './reflection/application/stages/entities.js';

export { ENTITY_DEDUP_METHOD, EntityDedupStage } from './reflection/application/stages/entity-dedup.js';
export type { EntityDedupStageOptions } from './reflection/application/stages/entity-dedup.js';

export { AssociationInferenceStage } from './reflection/application/stages/associations.js';
export type { AssociationStageOptions } from './reflection/application/stages/associations.js';

export { CognitiveExtractionStage } from './reflection/application/stages/cognitive.js';
export type { CognitiveExtractionStageOptions } from './reflection/application/stages/cognitive.js';

export { SemanticRelationshipStage } from './reflection/application/stages/semantic-relationships.js';
export type { SemanticRelationshipStageOptions } from './reflection/application/stages/semantic-relationships.js';

export { SupersessionStage } from './reflection/application/stages/supersession.js';
export type {
  SupersessionMode,
  SupersessionStageOptions,
} from './reflection/application/stages/supersession.js';

export {
  REFLECTION_CO_EXTRACTION_TRIGGER,
  ReinforcementEnqueueStage,
} from './reflection/application/stages/reinforcement.js';

export { ContextVectorStage } from './reflection/application/stages/context-vectors.js';

export {
  NARRATIVE_EXTRACTION_METHOD,
  NARRATIVE_STAGE_NAME,
  SessionNarrativeCloser,
  SessionNarrativeStage,
  closeSessionNarrative,
  sweepIdleSessions,
} from './reflection/application/narratives.js';
export type {
  IdleSweepOptions,
  NarrativeDeps,
  NarrativeOptions,
  NarrativeResult,
  NarrativeStatus,
  SessionNarrativeOptions,
} from './reflection/application/narratives.js';

export { IdleNarrativeSweeper, sweepIntervalMs } from './reflection/application/narrative-sweeper.js';
export type { IdleNarrativeSweeperOptions } from './reflection/application/narrative-sweeper.js';

export { loadEpisodeContext } from './infrastructure/graph/episode-context.js';
export type { EpisodeContext, EpisodeTurnContext } from './infrastructure/graph/episode-context.js';

export {
  DERIVES_FROM_TYPE,
  NARRATIVE_PROPERTIES,
  SUMMARIZED_BY_TYPE,
  findIdleSessions,
  findSessionNarratives,
  loadSessionEpisodes,
} from './infrastructure/graph/narrative-queries.js';
export type { IdleSession, SessionEpisode, SessionNarrative } from './infrastructure/graph/narrative-queries.js';

export {
  COGNITIVE_NODE_LABELS,
  deriveCognitiveNodeId,
  isCognitiveNodeLabel,
  normalizeCognitiveText,
} from './infrastructure/graph/cognitive-queries.js';
export type { CognitiveNodeLabel } from './infrastructure/graph/cognitive-queries.js';

export {
  ENTITY_MENTION_TYPE,
  ENTITY_PARTICIPATION_TYPE,
  findEpisodeEntities,
} from './infrastructure/graph/entity-queries.js';
export type { EpisodeEntity } from './infrastructure/graph/entity-queries.js';

export { CO_OCCURS_TYPE, SIMILAR_TYPE } from './infrastructure/graph/association-queries.js';

export {
  SEMANTIC_RELATIONSHIP_METHOD,
  SEMANTIC_RELATIONSHIP_TYPES,
  findEpisodeCognitiveNodes,
  isSemanticRelationshipType,
} from './infrastructure/graph/semantic-relationship-queries.js';
export type {
  EpisodeCognitiveNode,
  SemanticRelationshipType,
} from './infrastructure/graph/semantic-relationship-queries.js';

export { CONTEXT_VECTOR_PROPERTY } from './infrastructure/graph/context-vector-queries.js';

export {
  findSupersessionProposalsForNode,
  getSupersessionProposal,
  listSupersessionProposals,
  recordSupersessionProposal,
  resolveSupersessionProposal,
} from './infrastructure/sqlite/supersession-proposals.js';
export type { SupersessionProposal } from './infrastructure/sqlite/supersession-proposals.js';

export { hashContent, prepareEpisode, renderEpisodeText, stableStringify } from './reflection/domain/content.js';
export type { PreparedEpisode, PreparedTurn, ReflectionContent } from './reflection/domain/content.js';

export { buildAdjacencyStatement, fetchAdjacency } from './infrastructure/graph/adjacency.js';
export type { AdjacencyNeighbor, AdjacencyRequest } from './infrastructure/graph/adjacency.js';

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
} from './infrastructure/graph/seed-queries.js';
export type {
  EntityNameMatch,
  NodeContentVector,
  NodesByIdInput,
  ScoredSeedCandidate,
  SeedCandidate,
} from './infrastructure/graph/seed-queries.js';

export {
  ACCESS_COUNT_PROPERTY,
  buildRecordAccessStatement,
  recordAccess,
} from './infrastructure/graph/access-tracking.js';
export type { RecordAccessInput } from './infrastructure/graph/access-tracking.js';

export { CueCache, extractCues } from './recall/application/cues.js';
export type { CueExtractionDeps, CueExtractionInput, CueExtractionResult } from './recall/application/cues.js';

export {
  CALIBRATION_TOLERANCE,
  checkSeparation,
  describeDistribution,
  pairedCosines,
  pairwiseCosines,
  percentile,
} from './recall/domain/floor-calibration.js';
export type { Distribution, Separation, SeparationInput } from './recall/domain/floor-calibration.js';
export { measureAdmissionFloor } from './recall/application/floor-check.js';
export {
  BATTERY_SUBSTRATE,
  OFF_TOPIC_BATTERY,
  ON_TOPIC_BATTERY,
  RELATED_PAIRS,
  UNRELATED_PAIRS,
  UNRELATED_SENTENCES,
  WEAK_RELATED_PAIRS,
} from './recall/application/floors.fixtures.js';
export type {
  BatteryEpisode,
  OnTopicProbe,
  ScoredPair,
} from './recall/application/floors.fixtures.js';

export {
  SEED_STRATEGIES,
  mergeSeeds,
  normalizeToBest,
  recencyScore,
  scaleByCueWeight,
  selectSeeds,
} from './recall/application/seeds.js';
export type {
  Seed,
  SeedContribution,
  SeedCue,
  SeedProvenance,
  SeedSelection,
  SeedStrategy,
  SelectSeedsDeps,
  SelectSeedsInput,
} from './recall/application/seeds.js';

export {
  SEED_ACTIVATION,
  SUPERSEDED_ACTIVATION_WEIGHT,
  edgeWeight,
  hubInhibition,
  spreadActivation,
} from './recall/domain/activation.js';
export type {
  ActivatedNode,
  ActivationBudget,
  ActivationRun,
  ActivationSeed,
  ActivationTermination,
  AdjacencyFetch,
  SpreadActivationInput,
} from './recall/domain/activation.js';

export {
  buildRankedLists,
  seedCandidate,
  toActivationSeed,
  traversalCandidates,
} from './recall/application/candidates.js';
export type { RankedListInput, TraversalInput } from './recall/application/candidates.js';

export { SUPERSEDED_RANK_WEIGHT, cosineSimilarity, fuse, mmrOrder, reciprocalRank } from './recall/domain/fusion.js';
export type {
  FusedItem,
  FusionCandidate,
  FusionLeg,
  FusionOptions,
  FusionResult,
  RankedList,
} from './recall/domain/fusion.js';

export { admitsOnEvidence } from './recall/domain/admission.js';
export type {
  AdmissionPolicy,
  AdmissionReport,
  Bm25AdmissionMode,
  Measurement,
} from './recall/domain/admission.js';

export { CHARS_PER_TOKEN, PACK_BUCKETS, assemblePack, bucketFor, estimateTokens } from './recall/domain/pack.js';
export type { AssemblePackInput, BucketCaps, PackBucket } from './recall/domain/pack.js';

export { handleRecall, readModeFor } from './recall/application/recall.js';
export type { RecallCompletion, RecallDeps, RecallListener, RecallOptions } from './recall/application/recall.js';

export {
  REINFORCEMENT_TOP_N,
  REINFORCEMENT_TRIGGER,
  RecallSideEffects,
  reinforcementPairs,
} from './recall/application/side-effects.js';

export { foldForIdentity, foldName } from './infrastructure/providers/unicode-fold.js';

export {
  MIN_OVERLAP_NAME_LENGTH,
  NAME_FORM_OVERLAP_THRESHOLD,
  nameFormMatches,
  nameFormOverlap,
} from './reflection/domain/entity-identity.js';

export { MERGE_PROVENANCE_PROPERTY } from './infrastructure/graph/entity-dedup-queries.js';
export type { MergedEntityRecord } from './infrastructure/graph/entity-dedup-queries.js';

export {
  findEntityMergeProposalsForNode,
  getEntityMergeProposal,
  listEntityMergeProposals,
  recordEntityMergeProposal,
  resolveEntityMergeProposal,
} from './infrastructure/sqlite/entity-merge-proposals.js';
export type {
  EntityMergeProposal,
  EntityMergeProposalInput,
  EntityMergeProposalSide,
} from './infrastructure/sqlite/entity-merge-proposals.js';
