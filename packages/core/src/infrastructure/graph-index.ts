/**
 * Every graph module's public surface, re-exported into `infrastructure/index.ts` as one line.
 * It lives in its own file for one reason: the graph is most of the infrastructure layer, and
 * the combined barrel had passed the repo's line cap. Nothing here is graph-only policy; it is
 * a list.
 */

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

export type {
  GraphMigration,
  GraphMigrationOutcome,
  MigrationContext,
} from './graph/migrations.js';

export {
  GraphConnection,
  GraphTransaction,
  inWriteTransaction,
  runRead,
  runWrite,
  runWriteWithCounters,
} from './graph/connection.js';

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
  countNodesByLabel,
  readStoredText,
  readVectorIndexes,
} from './graph/introspection.js';

export type { GraphCounts, VectorIndexInfo } from './graph/introspection.js';

export {
  DEFAULT_HEALTH_SCAN_LIMIT,
  countEpisodesWithoutSession,
  countOrphanNodes,
  countVectorParity,
} from './graph/introspection-health.js';

export type { OrphanCounts, VectorParityCounts } from './graph/introspection-health.js';

export { findEpisodesMissingSessionLink } from './graph/backbone-repair-queries.js';

export type { BackboneRepairTarget } from './graph/backbone-repair-queries.js';

export { fetchNodeEdges, fetchNodeProvenance } from './graph/node-provenance.js';

export type { NodeEdge, NodeProvenance } from './graph/node-provenance.js';

export {
  BASE_NODE_LABEL,
  NODE_LABELS,
  isContentBearing,
  isNodeLabel,
  resolveLabels,
} from './graph/labels.js';

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
  buildDecayableEdgeCount,
  buildEdgeWeightDecay,
  buildEdgeWeightReinforcement,
  countDecayableEdges,
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
  forgetNode,
  stampNew,
  supersede,
  writeStampedNode,
  writeStampedNodeInTransaction,
} from './graph/bitemporal.js';

export type {
  ForgetNodeInput,
  ForgetNodeResult,
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

export {
  findClaimSubjects,
  findSubjectSiblings,
  siblingCloses,
  SUBJECT_PROPAGATION_METHOD,
  supersedeSubjectFamily,
} from './graph/subject-family.js';

export type {
  ClaimSubject,
  SubjectFamilyResult,
  SubjectSibling,
  SupersedeSubjectFamilyInput,
} from './graph/subject-family.js';

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

export type { FindEpisodeByContentHashInput, StoredEpisodeRef } from './graph/episodes.js';

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

export { loadEpisodeContext } from './graph/episode-context.js';

export type { EpisodeContext, EpisodeTurnContext } from './graph/episode-context.js';

export {
  DERIVES_FROM_TYPE,
  NARRATIVE_PROPERTIES,
  NARRATIVE_SUPERSEDED_GROUNDING,
  SUMMARIZED_BY_TYPE,
  findIdleSessions,
  findSessionNarratives,
  loadSessionEpisodes,
  markNarrativesForRegrounding,
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

export { MERGE_PROVENANCE_PROPERTY } from './graph/entity-dedup-queries.js';

export type { MergedEntityRecord } from './graph/entity-dedup-queries.js';

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

export { findOrphanNodes, findOrphanRelinkTargets } from './graph/topology-queries.js';

export type { OrphanNode, OrphanRelinkTarget, RelinkKind } from './graph/topology-queries.js';

export {
  COMMUNITY_MAX_ITERATIONS,
  COMMUNITY_PROPERTY,
  CONTENT_PROJECTION_NAME,
  countProjectableNodes,
  dropProjection,
  labelPropagationAvailable,
  projectContentGraph,
  readCommunityPairEdges,
  readCommunityProfiles,
  writeCommunities,
} from './graph/community-queries.js';

export type {
  CommunityPairEdges,
  CommunityProfile,
  CommunityWriteResult,
  ContentProjection,
} from './graph/community-queries.js';

export {
  BRIDGE_PROVENANCE,
  BRIDGE_SIGNAL,
  BRIDGE_SIMILARITY_PROPERTY,
  BRIDGE_SOURCE_COMMUNITY_PROPERTY,
  BRIDGE_TARGET_COMMUNITY_PROPERTY,
  countBridgesBetween,
  findClosestCrossCommunityPair,
  writeBridge,
} from './graph/bridge-queries.js';

export type { BridgeWrite, CrossCommunityPair } from './graph/bridge-queries.js';

export {
  applyUnmerge,
  readCanonicalMerge,
  readCanonicalMergeRecords,
  releasedNameNorm,
} from './graph/unmerge-queries.js';

export type {
  CanonicalMerge,
  MergeProvenanceEdge,
  MergeProvenanceRecord,
  UnmergeInput,
  UnmergeResult,
} from './graph/unmerge-queries.js';
