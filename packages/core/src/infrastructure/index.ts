/**
 * The infrastructure layer's public surface: config, providers, SQLite, logging, and the graph.
 * It names only what a package outside core imports, which is the line
 * `packages/core/src/barrel-consumers.test.ts` enforces and what keeps the file under the
 * line cap. Everything inside core reaches these modules by their own paths.
 */

export { openLogger } from './logging/logger.js';
export type { Logger } from './logging/logger.js';

export { describeError } from './errors.js';

export { halfWindowIntervalMs, MIN_SWEEP_INTERVAL_MS, SweepTimer } from './sweep-timer.js';

export { DEFAULT_SQLITE_PATH, SqliteStore, openSqliteHandle } from './sqlite/database.js';
export type { SqliteHandle } from './sqlite/database.js';

export {
  countExperiencesByVersion,
  experienceArchiveSpan,
  getExperienceByEpisode,
} from './sqlite/experience-archive.js';

export {
  getLedgerEntry,
  isLedgerApplied,
  latestLedgerEntry,
  listLedgerEntries,
  markLedgerApplied,
} from './sqlite/ops-ledger.js';

export {
  introspectionCycle,
  listOperationStats,
  meanOperationDurationMs,
} from './sqlite/introspection-counters.js';
export type { OperationStats } from './sqlite/introspection-counters.js';

export {
  REFLECTION_LANES,
  enqueueReflectionJob,
  findPendingReflectionJob,
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
} from './sqlite/served-items.js';

export { DEFAULTS, envFileValue, loadConfig, ConfigError } from './config/index.js';
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

export { scanHorizonIntegrity } from './graph/horizon-integrity.js';

export type { HorizonIntegrity } from './graph/horizon-integrity.js';

export { countAutoMergedEntities, entityMergePairState } from './graph/merge-shadow-queries.js';

export type { NodeEdge, NodeProvenance } from './graph/node-provenance.js';

export { upsertEdge } from './graph/edges.js';

export { forgetNode, supersede, writeStampedNode } from './graph/bitemporal.js';

export { findPendingVectorNodes } from './graph/pending-vectors.js';

export { supersedeEpisode } from './graph/episode-supersession.js';

export { previewSupersession, unsupersedeNode } from './graph/unsupersede.js';

export { readCanonicalMerge } from './graph/unmerge-queries.js';

export type { SupersessionPreview } from './graph/unsupersede.js';

export type { ClaimSubject, SubjectSibling } from './graph/subject-family.js';

export { bootstrapBackbone, readMemberName } from './graph/backbone.js';

export { ensureGraphSession } from './graph/sessions.js';

export { asOf, bitemporalAt, knewAt, withCurrency } from './graph/read-modes.js';

export type { ReadMode } from './graph/read-modes.js';

export { loadEpisodeContext } from './graph/episode-context.js';

export { listSessionEpisodeIds } from './graph/episodes.js';

export { NARRATIVE_PROPERTIES, findSessionNarratives } from './graph/narrative-queries.js';

export { ENTITY_MENTION_TYPE, findEpisodeEntities } from './graph/entity-queries.js';

export type { EpisodeEntity } from './graph/entity-queries.js';

export { CO_OCCURS_TYPE } from './graph/association-queries.js';

export { findEpisodeCognitiveNodes } from './graph/semantic-relationship-queries.js';

export { fetchAdjacency } from './graph/adjacency.js';

export { fetchItemOrigins } from './graph/origin-queries.js';

export type { ItemOrigin } from './graph/origin-queries.js';

export { fulltextSeeds, lucenePhraseQuery, vectorSeeds } from './graph/seed-queries.js';

export {
  EDGE_WEIGHT_DISTRIBUTION_TYPES,
  edgeWeightDistribution,
} from './graph/edge-weight-distribution.js';

export type { EdgeWeightDistribution } from './graph/edge-weight-distribution.js';

export type { Provider } from './providers/types.js';
export { embedQueryPrefix } from './providers/embed-models.js';
export {
  acceptsHookCapture,
  localChatModels,
  remoteBannerLines,
  remoteRoutes,
  resolveProviderRouting,
  routingSummary,
  unbackedPins,
} from './providers/routing.js';
export { ProviderRouter } from './providers/role-provider.js';
export { listResidentModels, reconcileResidentModels } from './providers/model-reconciliation.js';
export type { ReconciliationReport } from './providers/model-reconciliation.js';
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
  reopenSupersessionProposal,
} from './sqlite/supersession-proposals.js';
export type { SupersessionProposal } from './sqlite/supersession-proposals.js';

export {
  findEntityMergeProposalsForNode,
  getEntityMergeProposal,
  listEntityMergeProposals,
  recordEntityMergeProposal,
  reopenEntityMergeProposal,
} from './sqlite/entity-merge-proposals.js';
export type { EntityMergeProposal } from './sqlite/entity-merge-proposals.js';

export { cueDegradedRate } from './sqlite/recall-samples.js';

export {
  PACK_METHODS,
  packMethodCounters,
  packMethodLegStats,
  recordPackMethodCounts,
} from './sqlite/method-counters.js';
export type { PackMethodCounters, PackMethodLegStats } from './sqlite/method-counters.js';

export { recallCadenceCounters, recordRecallOutcome } from './sqlite/recall-cadence.js';
export type { RecallCadenceCounters } from './sqlite/recall-cadence.js';
