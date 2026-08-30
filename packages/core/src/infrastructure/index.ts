/**
 * The infrastructure layer's public surface: config, providers, SQLite, logging, and the graph.
 * Split out of the package entrypoint so `@aion/core` is unchanged by the split; the graph
 * section used to live in its own `graph-index.ts` until pruning this barrel down to what
 * `@aion/core` actually consumes brought the combined file back under the line cap.
 */

export { openLogger } from './logging/logger.js';
export type { Logger } from './logging/logger.js';

export { describeError } from './errors.js';

export { halfWindowIntervalMs, MIN_SWEEP_INTERVAL_MS, SweepTimer } from './sweep-timer.js';

export { SqliteStore, openSqliteHandle } from './sqlite/database.js';
export type { SqliteHandle } from './sqlite/database.js';

export {
  isLedgerApplied,
  latestLedgerEntry,
  listLedgerEntries,
  markLedgerApplied,
} from './sqlite/ops-ledger.js';
export type { OpsLedgerEntry } from './sqlite/ops-ledger.js';

export { introspectionCycle, listOperationStats } from './sqlite/introspection-counters.js';
export type { OperationStats } from './sqlite/introspection-counters.js';

export {
  REFLECTION_LANES,
  enqueueReflectionJob,
  isReflectionLane,
  listReflectionJobs,
} from './sqlite/reflection-queue.js';
export type { ReflectionJob, ReflectionLane } from './sqlite/reflection-queue.js';

export {
  countQueueJobs,
  countQueueJobsByLane,
  dropUnclaimedJobs,
  listQueueJobs,
  promoteJobs,
} from './sqlite/reflection-queue-admin.js';
export type { ReflectionQueueFilter } from './sqlite/reflection-queue-admin.js';

export { ReflectionQueueClaimant } from './sqlite/claim.js';

export { listReinforcementSignals } from './sqlite/reinforcement-queue.js';

export { p95EnrichmentLagMs } from './sqlite/lag-samples.js';

export { getLastPack, listLastPackSessions, saveLastPack } from './sqlite/last-pack.js';
export type { LastPackSession } from './sqlite/last-pack.js';

export {
  deleteServedItems,
  purgeServedItemsIdleSince,
  readServedItems,
  recordServedItems,
} from './sqlite/served-items.js';
export type { ServedItem } from './sqlite/served-items.js';

export { DEFAULTS, loadConfig, ConfigError } from './config/index.js';
export type { Config } from './config/index.js';

export {
  ensureNeo4jPassword,
  seedEnvFromTemplate,
  isManagedNeo4jUri,
  validateNeo4jEndpoint,
  verifyGdsAvailable,
} from './graph/provision.js';

export { latestAppliedGraphMigration, runGraphMigrations } from './graph/migrations.js';

export { GraphConnection } from './graph/connection.js';

export {
  assertVectorIndexDimensions,
  countGraphElements,
  countNodesByLabel,
  readVectorIndexes,
} from './graph/introspection.js';

export type { GraphCounts } from './graph/introspection.js';

export { fetchNodeEdges, fetchNodeProvenance } from './graph/node-provenance.js';

export {
  countAutoMergedEntities,
  entityMergePairState,
  wasEntityMergeApplied,
} from './graph/merge-shadow-queries.js';
export type { EntityMergePairState } from './graph/merge-shadow-queries.js';

export type { NodeEdge, NodeProvenance } from './graph/node-provenance.js';

export { upsertEdge } from './graph/edges.js';

export { forgetNode, supersede, writeStampedNode } from './graph/bitemporal.js';

export { supersedeEpisode } from './graph/episode-supersession.js';

export {
  EDGE_REOPENED_AT_PROPERTY,
  previewSupersession,
  unsupersedeNode,
} from './graph/unsupersede.js';

export type {
  ReopenedLineage,
  SupersessionPreview,
  UnsupersedeResult,
} from './graph/unsupersede.js';

export type { ClaimSubject, SubjectSibling } from './graph/subject-family.js';

export { bootstrapBackbone, readMemberName } from './graph/backbone.js';

export { ensureGraphSession } from './graph/sessions.js';

export { asOf, bitemporalAt, knewAt, withCurrency } from './graph/read-modes.js';

export type { ReadMode } from './graph/read-modes.js';

export { loadEpisodeContext } from './graph/episode-context.js';

export { NARRATIVE_PROPERTIES, findSessionNarratives } from './graph/narrative-queries.js';

export { ENTITY_MENTION_TYPE, findEpisodeEntities } from './graph/entity-queries.js';

export type { EpisodeEntity } from './graph/entity-queries.js';

export { CO_OCCURS_TYPE } from './graph/association-queries.js';

export { findEpisodeCognitiveNodes } from './graph/semantic-relationship-queries.js';

export { fetchAdjacency } from './graph/adjacency.js';

export { fulltextSeeds, lucenePhraseQuery, vectorSeeds } from './graph/seed-queries.js';

export {
  EDGE_WEIGHT_DISTRIBUTION_TYPES,
  edgeWeightDistribution,
} from './graph/edge-weight-distribution.js';

export type { EdgeWeightDistribution } from './graph/edge-weight-distribution.js';

export type { Provider } from './providers/types.js';
export {
  localChatModels,
  remoteBannerLines,
  remoteRoutes,
  resolveProviderRouting,
  routingSummary,
  unbackedPins,
} from './providers/routing.js';
export { ProviderRouter } from './providers/role-provider.js';
export { listResidentModels, reconcileResidentModels } from './providers/model-reconciliation.js';
export { EmbedDimensionMismatchError } from './providers/errors.js';
export { OllamaProvider } from './providers/ollama-provider.js';
export {
  checkOllamaReachable,
  listOllamaModels,
  provisionOllama,
  verifyOllamaChatModel,
} from './providers/provisioning.js';
export type { ProvisionEvent } from './providers/provisioning.js';

export {
  findSupersessionProposalsForNode,
  getSupersessionProposal,
  listSupersessionProposals,
  recordSupersessionProposal,
} from './sqlite/supersession-proposals.js';
export type { SupersessionProposal } from './sqlite/supersession-proposals.js';

export {
  findEntityMergeProposalsForNode,
  getEntityMergeProposal,
  listEntityMergeProposals,
  recordEntityMergeProposal,
  resolveEntityMergeProposal,
} from './sqlite/entity-merge-proposals.js';
export type {
  EntityMergeProposal,
  EntityMergeProposalSide,
} from './sqlite/entity-merge-proposals.js';

export { cueDegradedRate } from './sqlite/recall-samples.js';

export {
  PACK_METHODS,
  packMethodCounters,
  recordPackMethodCounts,
} from './sqlite/method-counters.js';
export type { PackMethodCounters } from './sqlite/method-counters.js';

export { recallCadenceCounters, recordRecallOutcome } from './sqlite/recall-cadence.js';
export type { RecallCadenceCounters } from './sqlite/recall-cadence.js';
