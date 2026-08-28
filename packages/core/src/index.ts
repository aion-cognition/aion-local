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
  markLedgerApplied,
} from './sqlite/ops-ledger.js';
export type { OpsLedgerEntry } from './sqlite/ops-ledger.js';

export {
  enqueueReflectionJob,
  findPendingReflectionJob,
  getReflectionJob,
  listReflectionJobs,
} from './sqlite/reflection-queue.js';
export type { ReflectionJob } from './sqlite/reflection-queue.js';

export {
  DEFAULT_STALE_CLAIM_TIMEOUT_MS,
  ReflectionQueueClaimant,
  reclaimStaleReflectionJobs,
} from './sqlite/claim.js';

export {
  enqueueReinforcementSignal,
  listReinforcementSignals,
} from './sqlite/reinforcement-queue.js';
export type { ReinforcementSignal } from './sqlite/reinforcement-queue.js';

export { getLastPack, saveLastPack } from './sqlite/last-pack.js';
export type { LastPack } from './sqlite/last-pack.js';

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
} from './graph/errors.js';

export {
  VECTOR_INDEX_NAMES,
  assertVectorIndexDimensions,
  countGraphElements,
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

export { bootstrapBackbone, GLOBAL_WORKSPACE_NAME } from './graph/backbone.js';
export type { BootstrapBackboneInput, BootstrapBackboneResult } from './graph/backbone.js';

export {
  CONTAINMENT_TYPE,
  MEMORY_PROPERTIES,
  findEpisodeByContentHash,
  findEpisodeByContentHashInTransaction,
} from './graph/episodes.js';
export type { FindEpisodeByContentHashInput } from './graph/episodes.js';

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

export { DEFAULT_ENTROPY_THRESHOLD, redact } from './redact/redact.js';
export type { RedactionMatch, RedactionResult } from './redact/redact.js';
export { redactPayload } from './redact/deep-walk.js';
export type { DeepRedactionResult } from './redact/deep-walk.js';
export { HIGH_ENTROPY_RULE_ID, REDACTION_RULES, REDACTION_RULE_IDS } from './redact/rules.js';
export type { RedactionRule } from './redact/rules.js';
export { buildFingerprint } from './redact/fingerprint.js';
export { findHighEntropyTokens, shannonEntropy } from './redact/entropy.js';
export type { TextSpan } from './redact/entropy.js';

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
} from './reflection/intake.js';
export type { ReflectionIntakeDeps, ReflectionIntakeOptions } from './reflection/intake.js';

export { ReflectionDispatch } from './reflection/dispatch.js';
export type {
  ReflectionDispatchOptions,
  ReflectionJobListener,
  ReflectionJobSignal,
} from './reflection/dispatch.js';

export { hashContent, prepareEpisode, renderEpisodeText, stableStringify } from './reflection/content.js';
export type { PreparedEpisode, PreparedTurn, ReflectionContent } from './reflection/content.js';

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

export { CueCache, extractCues } from './recall/cues.js';
export type { CueExtractionDeps, CueExtractionInput, CueExtractionResult } from './recall/cues.js';

export {
  SEED_STRATEGIES,
  mergeSeeds,
  normalizeToBest,
  recencyScore,
  scaleByCueWeight,
  selectSeeds,
} from './recall/seeds.js';
export type {
  Seed,
  SeedContribution,
  SeedCue,
  SeedProvenance,
  SeedSelection,
  SeedStrategy,
  SelectSeedsDeps,
  SelectSeedsInput,
} from './recall/seeds.js';

export {
  SEED_ACTIVATION,
  SUPERSEDED_ACTIVATION_WEIGHT,
  edgeWeight,
  hubInhibition,
  spreadActivation,
} from './recall/activation.js';
export type {
  ActivatedNode,
  ActivationBudget,
  ActivationRun,
  ActivationSeed,
  ActivationTermination,
  AdjacencyFetch,
  SpreadActivationInput,
} from './recall/activation.js';

export {
  buildRankedLists,
  seedCandidate,
  toActivationSeed,
  traversalCandidates,
} from './recall/candidates.js';
export type { RankedListInput, TraversalInput } from './recall/candidates.js';

export { SUPERSEDED_RANK_WEIGHT, cosineSimilarity, fuse, mmrOrder, reciprocalRank } from './recall/fusion.js';
export type {
  FusedItem,
  FusionCandidate,
  FusionLeg,
  FusionOptions,
  RankedList,
} from './recall/fusion.js';

export { CHARS_PER_TOKEN, PACK_BUCKETS, assemblePack, bucketFor, estimateTokens } from './recall/pack.js';
export type { AssemblePackInput, BucketCaps, PackBucket } from './recall/pack.js';

export { handleRecall, readModeFor } from './recall/recall.js';
export type { RecallCompletion, RecallDeps, RecallListener, RecallOptions } from './recall/recall.js';
