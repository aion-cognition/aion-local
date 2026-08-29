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
 * search.weights sub-fields from a single comma-separated var (PRD §14); every other
 * leaf is a 1:1 var. Env var names already pinned by PRD §14 (AION_CUE_BUDGET_MS,
 * AION_RECALL_TOKEN_BUDGET, AION_SEARCH_WEIGHTS, AION_NEO4J_URI,
 * AION_NEO4J_PASSWORD, AION_OLLAMA_URL, AION_OLLAMA_MODE, AION_ANTHROPIC_API_KEY,
 * AION_MAINTENANCE_TIER3, AION_MCP_PORT) keep those exact names; the rest follow
 * AION_<GROUP>_<LEAF> for consistency.
 *
 * PRD §14's AION_MIN_RELEVANCE is gone rather than renamed. It named one floor for every
 * method, which is the shape the fix round removed; a stale 0.35 silently applying to the
 * calibrated cosine floor would be worse than the error an unknown variable raises.
 *
 * P3's two plan-pinned names (AION_SUPERSEDE_AUTO_CONFIDENCE, AION_ASSOC_SEMANTIC_THRESHOLD)
 * are the same case and keep their pinned spelling inside the `reflection` group, as does the
 * fix round's AION_SUPERSEDE_MODE, which took over the gating role the confidence knob had. The
 * worker's knobs live under `operational` and read AION_WORKER_*, which is where
 * AION_WORKER_COUNT already was. AION_REINFORCEMENT_QUEUE_CAP and AION_PACK_CLUSTER_CAP are
 * the fix-round plan's pinned names and keep that spelling rather than
 * AION_SQLITE_REINFORCEMENT_QUEUE_CAP / AION_RECALL_CLUSTER_CAP.
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

  {
    envVar: 'AION_CONTEXT_RESONANCE_SEED_LIMIT',
    path: ['contextResonance', 'seedLimit'],
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
