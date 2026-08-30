import { LOG_FILE_ENV_VAR, LOG_LEVEL_ENV_VAR } from '../logging/logger.js';
import { SQLITE_PATH_ENV_VAR } from '../sqlite/database.js';

export type KnobKind = 'string' | 'number' | 'boolean' | 'weights' | 'stringList';

export type ConfigPath = readonly [group: string, leaf: string];

export type Knob = {
  envVar: string;
  path: ConfigPath;
  kind: KnobKind;
};

/**
 * The flat AION_* surface, one entry per Config leaf. `weights` covers the three
 * search.weights sub-fields from a single comma-separated var; every other leaf is a
 * 1:1 var. A fixed set of env var names (AION_CUE_BUDGET_MS, AION_RECALL_TOKEN_BUDGET,
 * AION_SEARCH_WEIGHTS, AION_NEO4J_URI, AION_NEO4J_PASSWORD, AION_OLLAMA_URL,
 * AION_OLLAMA_MODE, AION_ANTHROPIC_API_KEY, AION_MAINTENANCE_TIER3, AION_MCP_PORT) keep
 * their existing spelling; the rest follow AION_<GROUP>_<LEAF> for consistency.
 *
 * AION_MIN_RELEVANCE is gone rather than renamed. It named one floor for every search
 * method, and each method now has its own calibrated cosine floor; a stale 0.35 silently
 * applying to a calibrated floor would be worse than the error an unknown variable raises.
 *
 * AION_SUPERSEDE_AUTO_CONFIDENCE and AION_ASSOC_SEMANTIC_THRESHOLD are the same case and
 * keep their existing spelling inside the `reflection` group, as does AION_SUPERSEDE_MODE,
 * which took over the gating role the confidence knob had. The worker's knobs live under
 * `operational` and read AION_WORKER_*, which is where AION_WORKER_COUNT already was.
 * AION_REINFORCEMENT_QUEUE_CAP and AION_PACK_CLUSTER_CAP keep their existing spelling
 * rather than AION_SQLITE_REINFORCEMENT_QUEUE_CAP / AION_RECALL_CLUSTER_CAP, and
 * AION_SEED_BUDGET_BASE / AION_SEED_BUDGET_GROWTH are named for the budget they shape rather
 * than for the group that holds them alongside the cap.
 */
export const KNOB_REGISTRY: readonly Knob[] = [
  { envVar: 'AION_NEO4J_URI', path: ['neo4j', 'uri'], kind: 'string' },
  { envVar: 'AION_NEO4J_PASSWORD', path: ['neo4j', 'password'], kind: 'string' },

  { envVar: 'AION_OLLAMA_URL', path: ['ollama', 'url'], kind: 'string' },
  { envVar: 'AION_OLLAMA_MODE', path: ['ollama', 'mode'], kind: 'string' },

  { envVar: 'AION_EMBED_MODEL', path: ['models', 'embed'], kind: 'string' },
  { envVar: 'AION_EMBED_DIMENSION', path: ['models', 'embedDimension'], kind: 'number' },
  { envVar: 'AION_CUE_MODEL', path: ['models', 'cue'], kind: 'string' },
  { envVar: 'AION_REFLECT_MODEL', path: ['models', 'reflect'], kind: 'string' },

  { envVar: 'AION_ANTHROPIC_API_KEY', path: ['anthropic', 'apiKey'], kind: 'string' },
  { envVar: 'AION_ANTHROPIC_MODEL', path: ['anthropic', 'model'], kind: 'string' },

  // Named for the role they pin rather than AION_ROUTING_*, so they read next to
  // AION_CUE_MODEL and AION_REFLECT_MODEL, which are the models they route.
  { envVar: 'AION_CUE_PROVIDER', path: ['routing', 'cue'], kind: 'string' },
  { envVar: 'AION_REFLECT_PROVIDER', path: ['routing', 'reflect'], kind: 'string' },

  { envVar: 'AION_RECALL_MAX_HOPS', path: ['recall', 'maxHops'], kind: 'number' },
  { envVar: 'AION_RECALL_VECTOR_LIMIT', path: ['recall', 'vectorLimit'], kind: 'number' },
  { envVar: 'AION_RECALL_MAX_FACTS', path: ['recall', 'maxFacts'], kind: 'number' },
  { envVar: 'AION_RECALL_MAX_EPISODES', path: ['recall', 'maxEpisodes'], kind: 'number' },
  { envVar: 'AION_RECALL_MAX_NARRATIVES', path: ['recall', 'maxNarratives'], kind: 'number' },
  { envVar: 'AION_RECALL_MAX_PREFERENCES', path: ['recall', 'maxPreferences'], kind: 'number' },
  { envVar: 'AION_RECALL_MAX_RESONANT', path: ['recall', 'maxResonant'], kind: 'number' },
  {
    envVar: 'AION_RECALL_USE_CONTEXT_RESONANCE',
    path: ['recall', 'useContextResonance'],
    kind: 'boolean',
  },
  {
    envVar: 'AION_RECALL_ASSOCIATION_STRENGTH',
    path: ['recall', 'associationStrength'],
    kind: 'number',
  },
  {
    envVar: 'AION_RECALL_COMPRESSION_THRESHOLD',
    path: ['recall', 'compressionThreshold'],
    kind: 'number',
  },
  { envVar: 'AION_CUE_BUDGET_MS', path: ['recall', 'cueBudgetMs'], kind: 'number' },
  { envVar: 'AION_RECALL_TOKEN_BUDGET', path: ['recall', 'tokenBudget'], kind: 'number' },
  {
    envVar: 'AION_VECTOR_ADMISSION_FLOOR',
    path: ['recall', 'vectorAdmissionFloor'],
    kind: 'number',
  },
  { envVar: 'AION_CORROBORATION_FLOOR', path: ['recall', 'corroborationFloor'], kind: 'number' },
  { envVar: 'AION_BM25_ADMISSION_MODE', path: ['recall', 'bm25AdmissionMode'], kind: 'string' },
  {
    envVar: 'AION_RECALL_ENTITY_MATCH_THRESHOLD',
    path: ['recall', 'entityMatchThreshold'],
    kind: 'number',
  },
  { envVar: 'AION_PACK_CLUSTER_CAP', path: ['recall', 'clusterCap'], kind: 'number' },
  { envVar: 'AION_PACK_ENTITY_GLOSS_CAP', path: ['recall', 'entityGlossCap'], kind: 'number' },
  {
    envVar: 'AION_FACTS_RESTATEMENT_FLOOR',
    path: ['recall', 'restatementFloor'],
    kind: 'number',
  },
  { envVar: 'AION_DECISION_INTENT_BOOST', path: ['recall', 'decisionBoost'], kind: 'number' },

  { envVar: 'AION_SEARCH_METHODS', path: ['search', 'methods'], kind: 'stringList' },
  { envVar: 'AION_SEARCH_RERANKER', path: ['search', 'reranker'], kind: 'string' },
  { envVar: 'AION_SEARCH_RRF_CONSTANT', path: ['search', 'rrfConstant'], kind: 'number' },
  { envVar: 'AION_SEARCH_MMR_LAMBDA', path: ['search', 'mmrLambda'], kind: 'number' },
  { envVar: 'AION_SEARCH_WEIGHTS', path: ['search', 'weights'], kind: 'weights' },

  { envVar: 'AION_ACTIVATION_MAX_ITERATIONS', path: ['activation', 'maxIterations'], kind: 'number' },
  { envVar: 'AION_ACTIVATION_DECAY_FACTOR', path: ['activation', 'decayFactor'], kind: 'number' },
  { envVar: 'AION_ACTIVATION_MIN_ACTIVATION', path: ['activation', 'minActivation'], kind: 'number' },
  {
    envVar: 'AION_ACTIVATION_MAX_NODES_VISITED',
    path: ['activation', 'maxNodesVisited'],
    kind: 'number',
  },
  { envVar: 'AION_ACTIVATION_HUB_THRESHOLD', path: ['activation', 'hubThreshold'], kind: 'number' },

  { envVar: 'AION_HEBBIAN_WEIGHT_FLOOR', path: ['hebbian', 'weightFloor'], kind: 'number' },
  { envVar: 'AION_HEBBIAN_LEARNING_RATE', path: ['hebbian', 'learningRate'], kind: 'number' },
  { envVar: 'AION_HEBBIAN_DECAY_RATE', path: ['hebbian', 'decayRate'], kind: 'number' },
  { envVar: 'AION_HEBBIAN_DECAY_PEAK_DAYS', path: ['hebbian', 'decayPeakDays'], kind: 'number' },
  { envVar: 'AION_HEBBIAN_DECAY_SIGMA', path: ['hebbian', 'decaySigma'], kind: 'number' },
  { envVar: 'AION_HEBBIAN_BATCH_SIZE', path: ['hebbian', 'batchSize'], kind: 'number' },
  { envVar: 'AION_HEBBIAN_FLUSH_INTERVAL_MS', path: ['hebbian', 'flushIntervalMs'], kind: 'number' },

  // Keeps its spelling and its group. Its meaning narrowed: it is now the ceiling on a seed
  // budget that scales with the substrate, not the budget. A deployment that pinned it low
  // still gets exactly that many seeds, which is why it was not renamed.
  {
    envVar: 'AION_CONTEXT_RESONANCE_SEED_LIMIT',
    path: ['contextResonance', 'seedLimit'],
    kind: 'number',
  },
  { envVar: 'AION_SEED_BUDGET_BASE', path: ['contextResonance', 'seedBudgetBase'], kind: 'number' },
  {
    envVar: 'AION_SEED_BUDGET_GROWTH',
    path: ['contextResonance', 'seedBudgetGrowth'],
    kind: 'number',
  },
  {
    envVar: 'AION_CONTEXT_RESONANCE_ACTIVATION_LIMIT',
    path: ['contextResonance', 'activationLimit'],
    kind: 'number',
  },
  {
    envVar: 'AION_CONTEXT_RESONANCE_RESONANT_LIMIT',
    path: ['contextResonance', 'resonantLimit'],
    kind: 'number',
  },
  { envVar: 'AION_CONTEXT_RESONANCE_MAX_HOPS', path: ['contextResonance', 'maxHops'], kind: 'number' },
  {
    envVar: 'AION_CONTEXT_RESONANCE_ACTIVATION_THRESHOLD',
    path: ['contextResonance', 'activationThreshold'],
    kind: 'number',
  },
  {
    envVar: 'AION_CONTEXT_RESONANCE_CONTEXT_SEARCH_THRESHOLD',
    path: ['contextResonance', 'contextSearchThreshold'],
    kind: 'number',
  },

  {
    envVar: 'AION_REFLECTION_ENTITY_TIMEOUT_MS',
    path: ['reflection', 'entityTimeoutMs'],
    kind: 'number',
  },
  { envVar: 'AION_REFLECTION_MAX_ENTITIES', path: ['reflection', 'maxEntities'], kind: 'number' },
  {
    envVar: 'AION_REFLECTION_ENTITY_DEDUP_THRESHOLD',
    path: ['reflection', 'entityDedupThreshold'],
    kind: 'number',
  },
  {
    envVar: 'AION_ASSOC_SEMANTIC_THRESHOLD',
    path: ['reflection', 'associationSemanticThreshold'],
    kind: 'number',
  },
  {
    envVar: 'AION_REFLECTION_ASSOCIATION_SIMILAR_LIMIT',
    path: ['reflection', 'associationSimilarLimit'],
    kind: 'number',
  },
  {
    envVar: 'AION_REFLECTION_COGNITIVE_TIMEOUT_MS',
    path: ['reflection', 'cognitiveTimeoutMs'],
    kind: 'number',
  },
  {
    envVar: 'AION_REFLECTION_MAX_COGNITIVE_NODES',
    path: ['reflection', 'maxCognitiveNodes'],
    kind: 'number',
  },
  {
    envVar: 'AION_REFLECTION_SEMANTIC_TIMEOUT_MS',
    path: ['reflection', 'semanticTimeoutMs'],
    kind: 'number',
  },
  {
    envVar: 'AION_REFLECTION_MAX_RELATIONSHIPS',
    path: ['reflection', 'maxRelationships'],
    kind: 'number',
  },
  {
    envVar: 'AION_SUPERSEDE_MODE',
    path: ['reflection', 'supersedeMode'],
    kind: 'string',
  },
  {
    envVar: 'AION_SUPERSEDE_AUTO_CONFIDENCE',
    path: ['reflection', 'supersedeAutoConfidence'],
    kind: 'number',
  },
  {
    envVar: 'AION_REFLECTION_SUPERSEDE_NEIGHBOR_THRESHOLD',
    path: ['reflection', 'supersedeNeighborThreshold'],
    kind: 'number',
  },
  {
    envVar: 'AION_REFLECTION_SUPERSEDE_TIMEOUT_MS',
    path: ['reflection', 'supersedeTimeoutMs'],
    kind: 'number',
  },
  {
    envVar: 'AION_REFLECTION_MAX_SUPERSESSION_SUBJECTS',
    path: ['reflection', 'maxSupersessionSubjects'],
    kind: 'number',
  },
  {
    envVar: 'AION_REFLECTION_MAX_CONTRADICTION_NEIGHBORS',
    path: ['reflection', 'maxContradictionNeighbors'],
    kind: 'number',
  },
  {
    envVar: 'AION_REFLECTION_MAX_CONTRADICTION_JUDGMENTS',
    path: ['reflection', 'maxContradictionJudgments'],
    kind: 'number',
  },
  {
    envVar: 'AION_REFLECTION_NARRATIVE_IDLE_MINUTES',
    path: ['reflection', 'narrativeIdleMinutes'],
    kind: 'number',
  },
  {
    envVar: 'AION_REFLECTION_NARRATIVE_TIMEOUT_MS',
    path: ['reflection', 'narrativeTimeoutMs'],
    kind: 'number',
  },
  {
    envVar: 'AION_REFLECTION_MAX_NARRATIVE_EPISODES',
    path: ['reflection', 'maxNarrativeEpisodes'],
    kind: 'number',
  },
  {
    envVar: 'AION_REFLECTION_MAX_NARRATIVE_EPISODE_CHARS',
    path: ['reflection', 'maxNarrativeEpisodeChars'],
    kind: 'number',
  },
  {
    envVar: 'AION_REFLECTION_NARRATIVE_SWEEP_LIMIT',
    path: ['reflection', 'narrativeSweepLimit'],
    kind: 'number',
  },

  { envVar: 'AION_LANE_ARRIVAL_WINDOW_MS', path: ['lanes', 'arrivalWindowMs'], kind: 'number' },
  { envVar: 'AION_LANE_SESSION_ARRIVAL_MAX', path: ['lanes', 'sessionArrivalMax'], kind: 'number' },
  { envVar: 'AION_LANE_GLOBAL_ARRIVAL_MAX', path: ['lanes', 'globalArrivalMax'], kind: 'number' },
  {
    envVar: 'AION_LANE_HOT_SESSION_ARRIVAL_MAX',
    path: ['lanes', 'hotSessionArrivalMax'],
    kind: 'number',
  },

  { envVar: 'AION_REDACTION_ENTROPY_THRESHOLD', path: ['redaction', 'entropyThreshold'], kind: 'number' },

  { envVar: 'AION_MAINTENANCE_TIER3', path: ['maintenance', 'tier3'], kind: 'boolean' },
  {
    envVar: 'AION_MAINTENANCE_TICK_MINUTES',
    path: ['maintenance', 'tickMinutes'],
    kind: 'number',
  },
  {
    envVar: 'AION_MAINTENANCE_STARVATION_CYCLES',
    path: ['maintenance', 'starvationCycles'],
    kind: 'number',
  },
  {
    envVar: 'AION_MAINTENANCE_URGENCY_THRESHOLD',
    path: ['maintenance', 'urgencyThreshold'],
    kind: 'number',
  },
  {
    envVar: 'AION_MAINTENANCE_EFFECTIVENESS_FLOOR',
    path: ['maintenance', 'effectivenessFloor'],
    kind: 'number',
  },
  {
    envVar: 'AION_MAINTENANCE_VECTOR_BACKFILL_BATCH_SIZE',
    path: ['maintenance', 'vectorBackfillBatchSize'],
    kind: 'number',
  },
  {
    envVar: 'AION_MAINTENANCE_CONTEXT_REFRESH_BATCH_SIZE',
    path: ['maintenance', 'contextRefreshBatchSize'],
    kind: 'number',
  },
  {
    envVar: 'AION_MAINTENANCE_RECONCILE_BATCH_SIZE',
    path: ['maintenance', 'reconcileBatchSize'],
    kind: 'number',
  },
  {
    envVar: 'AION_MAINTENANCE_DEAD_LETTER_BATCH_SIZE',
    path: ['maintenance', 'deadLetterBatchSize'],
    kind: 'number',
  },
  {
    envVar: 'AION_MAINTENANCE_REDACTION_PURGE_BATCH_SIZE',
    path: ['maintenance', 'redactionPurgeBatchSize'],
    kind: 'number',
  },
  {
    envVar: 'AION_MAINTENANCE_NARRATIVE_CLEANUP_BATCH',
    path: ['maintenance', 'narrativeCleanupBatch'],
    kind: 'number',
  },
  {
    envVar: 'AION_MAINTENANCE_RETRO_SUPERSESSION_BATCH',
    path: ['maintenance', 'retroSupersessionBatch'],
    kind: 'number',
  },
  {
    envVar: 'AION_MAINTENANCE_DESCRIPTION_REFRESH_BATCH',
    path: ['maintenance', 'descriptionRefreshBatch'],
    kind: 'number',
  },
  {
    envVar: 'AION_MAINTENANCE_DESCRIPTION_REFRESH_MENTION_GROWTH',
    path: ['maintenance', 'descriptionRefreshMentionGrowth'],
    kind: 'number',
  },
  {
    envVar: 'AION_MAINTENANCE_BACKBONE_REPAIR_BATCH',
    path: ['maintenance', 'backboneRepairBatch'],
    kind: 'number',
  },
  {
    envVar: 'AION_MAINTENANCE_ORPHAN_CLEANUP_BATCH',
    path: ['maintenance', 'orphanCleanupBatch'],
    kind: 'number',
  },
  {
    envVar: 'AION_MAINTENANCE_ORPHAN_FORGET_AFTER_DAYS',
    path: ['maintenance', 'orphanForgetAfterDays'],
    kind: 'number',
  },
  {
    envVar: 'AION_MAINTENANCE_COMMUNITY_NODE_LIMIT',
    path: ['maintenance', 'communityNodeLimit'],
    kind: 'number',
  },
  {
    envVar: 'AION_MAINTENANCE_COMMUNITY_MIN_NODES',
    path: ['maintenance', 'communityMinNodes'],
    kind: 'number',
  },
  {
    envVar: 'AION_MAINTENANCE_BRIDGE_MIN_COMMUNITY_SIZE',
    path: ['maintenance', 'bridgeMinCommunitySize'],
    kind: 'number',
  },

  { envVar: SQLITE_PATH_ENV_VAR, path: ['sqlite', 'path'], kind: 'string' },
  {
    envVar: 'AION_REINFORCEMENT_QUEUE_CAP',
    path: ['sqlite', 'reinforcementQueueCap'],
    kind: 'number',
  },

  { envVar: 'AION_DATA_DIR', path: ['operational', 'dataDir'], kind: 'string' },
  { envVar: 'AION_MCP_PORT', path: ['operational', 'mcpPort'], kind: 'number' },
  { envVar: 'AION_WORKER_COUNT', path: ['operational', 'workerCount'], kind: 'number' },
  {
    envVar: 'AION_WORKER_STALE_CLAIM_TIMEOUT_MS',
    path: ['operational', 'workerStaleClaimTimeoutMs'],
    kind: 'number',
  },
  { envVar: 'AION_WORKER_RETRY_BASE_MS', path: ['operational', 'workerRetryBaseMs'], kind: 'number' },
  { envVar: 'AION_WORKER_RETRY_CAP_MS', path: ['operational', 'workerRetryCapMs'], kind: 'number' },
  { envVar: 'AION_WORKER_MAX_ATTEMPTS', path: ['operational', 'workerMaxAttempts'], kind: 'number' },
  {
    envVar: 'AION_WORKER_BREAKER_THRESHOLD',
    path: ['operational', 'workerBreakerThreshold'],
    kind: 'number',
  },
  {
    envVar: 'AION_WORKER_BREAKER_COOLDOWN_MS',
    path: ['operational', 'workerBreakerCooldownMs'],
    kind: 'number',
  },
  {
    envVar: 'AION_WORKER_VECTOR_BATCH_SIZE',
    path: ['operational', 'workerVectorBatchSize'],
    kind: 'number',
  },
  {
    envVar: 'AION_RECONCILE_WARN_THRESHOLD',
    path: ['operational', 'reconcileWarnThreshold'],
    kind: 'number',
  },
  {
    envVar: 'AION_LAG_OLDEST_UNCLAIMED_WARN_MS',
    path: ['operational', 'lagOldestUnclaimedWarnMs'],
    kind: 'number',
  },
  {
    envVar: 'AION_LAG_QUEUE_DEPTH_WARN_THRESHOLD',
    path: ['operational', 'lagQueueDepthWarnThreshold'],
    kind: 'number',
  },
  {
    envVar: 'AION_SESSION_IDLE_EXPIRY_MINUTES',
    path: ['operational', 'sessionIdleExpiryMinutes'],
    kind: 'number',
  },

  { envVar: LOG_FILE_ENV_VAR, path: ['logging', 'filePath'], kind: 'string' },
  { envVar: LOG_LEVEL_ENV_VAR, path: ['logging', 'level'], kind: 'string' },
];

/**
 * AION_*-prefixed variables that `bin/aion` passes through to the container for compose
 * and the CLI, not for config: the host repo path compose interpolates its bind mount
 * from, and the `git config user.name` the backbone bootstrap confirms. They are listed
 * here so the unknown-variable check keeps catching typos in real knobs.
 */
export const RESERVED_ENV_VARS: ReadonlySet<string> = new Set(['AION_REPO_PATH', 'AION_GIT_USER_NAME']);

const registryByEnvVar = new Map(KNOB_REGISTRY.map((knob) => [knob.envVar, knob]));

export function knownEnvVars(): ReadonlySet<string> {
  return new Set(registryByEnvVar.keys());
}

export function envVarForPath(path: readonly string[]): string | undefined {
  const joined = path.join('.');
  const match = KNOB_REGISTRY.find((knob) => knob.path.join('.') === joined);
  return match?.envVar;
}
