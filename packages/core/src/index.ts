export {
  DEFAULT_LOG_FILE,
  DEFAULT_LOG_LEVEL,
  LOG_FILE_ENV_VAR,
  LOG_LEVEL_ENV_VAR,
  LOG_LEVELS,
  isLogLevel,
  logTargetFromEnv,
  openLogger,
} from './logging/logger.js';
export type { LogLevel, LogTarget, Logger } from './logging/logger.js';

export {
  DEFAULT_BUSY_TIMEOUT_MS,
  DEFAULT_SQLITE_PATH,
  SQLITE_PATH_ENV_VAR,
  SqliteStore,
  openSqliteHandle,
  sqlitePathFromEnv,
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
  getReflectionJob,
  listReflectionJobs,
} from './sqlite/reflection-queue.js';
export type { ReflectionJob } from './sqlite/reflection-queue.js';

export {
  enqueueReinforcementSignal,
  listReinforcementSignals,
} from './sqlite/reinforcement-queue.js';
export type { ReinforcementSignal } from './sqlite/reinforcement-queue.js';

export { getLastPack, saveLastPack } from './sqlite/last-pack.js';
export type { LastPack } from './sqlite/last-pack.js';

export { ConfigSchema, DEFAULTS, KNOB_REGISTRY, knownEnvVars, envVarForPath, loadConfig, ConfigError } from './config/index.js';
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
export type { GraphMigration, MigrationContext } from './graph/migrations.js';

export { GraphConnection, GraphTransaction, inWriteTransaction, runRead, runWrite, runWriteWithCounters } from './graph/connection.js';
export type { GraphHealth, GraphStatement, WriteOutcome } from './graph/connection.js';

export { GraphNodeNotFoundError, GraphWriteError } from './graph/errors.js';

export { NODE_LABELS, isContentBearing, isNodeLabel, resolveLabels } from './graph/labels.js';
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
  BITEMPORAL_PROPERTIES,
  buildStampedNodeWrite,
  stampNew,
  supersede,
  writeStampedNode,
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
export { checkOllamaReachable, provisionOllama } from './providers/provisioning.js';
export type { OllamaProvisionTarget, ProvisionEvent, ProvisionOptions } from './providers/provisioning.js';
