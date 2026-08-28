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
 * AION_RECALL_TOKEN_BUDGET, AION_MIN_RELEVANCE, AION_SEARCH_WEIGHTS, AION_NEO4J_URI,
 * AION_NEO4J_PASSWORD, AION_OLLAMA_URL, AION_OLLAMA_MODE, AION_ANTHROPIC_API_KEY,
 * AION_MAINTENANCE_TIER3, AION_MCP_PORT) keep those exact names; the rest follow
 * AION_<GROUP>_<LEAF> for consistency.
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
  { envVar: 'AION_MIN_RELEVANCE', path: ['recall', 'minRelevance'], kind: 'number' },
  {
    envVar: 'AION_RECALL_ENTITY_MATCH_THRESHOLD',
    path: ['recall', 'entityMatchThreshold'],
    kind: 'number',
  },

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

  { envVar: 'AION_REDACTION_ENTROPY_THRESHOLD', path: ['redaction', 'entropyThreshold'], kind: 'number' },

  { envVar: 'AION_MAINTENANCE_TIER3', path: ['maintenance', 'tier3'], kind: 'boolean' },

  { envVar: SQLITE_PATH_ENV_VAR, path: ['sqlite', 'path'], kind: 'string' },

  { envVar: 'AION_DATA_DIR', path: ['operational', 'dataDir'], kind: 'string' },
  { envVar: 'AION_MCP_PORT', path: ['operational', 'mcpPort'], kind: 'number' },
  { envVar: 'AION_WORKER_COUNT', path: ['operational', 'workerCount'], kind: 'number' },

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
