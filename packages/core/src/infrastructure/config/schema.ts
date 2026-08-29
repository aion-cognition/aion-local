import { z } from 'zod';
import { LOG_LEVELS } from '../logging/logger.js';

/**
 * Range constraints below come from PRD §14 and whitepaper Appendix E where a value
 * is pinned; the rest (int/positive/0-1) are defensive shape checks, not tuned limits.
 */
const proportion = z.number().min(0).max(1);
const positiveInt = z.number().int().positive();
const nonNegativeInt = z.number().int().nonnegative();

const searchMethod = z.enum(['vector', 'bm25', 'graph_traversal']);

export const ConfigSchema = z.object({
  neo4j: z.object({
    uri: z.string().min(1),
    password: z.string(),
  }),
  ollama: z.object({
    url: z.string().min(1),
    mode: z.enum(['baremetal', 'docker']),
  }),
  models: z.object({
    embed: z.string().min(1),
    embedDimension: positiveInt,
    cue: z.string().min(1),
    reflect: z.string().min(1),
  }),
  anthropic: z.object({
    /** Empty string means fully local; a non-empty key opts a call class into a remote provider. */
    apiKey: z.string(),
  }),
  recall: z.object({
    maxHops: nonNegativeInt,
    vectorLimit: positiveInt,
    maxFacts: nonNegativeInt,
    maxEpisodes: nonNegativeInt,
    maxNarratives: nonNegativeInt,
    maxPreferences: nonNegativeInt,
    maxResonant: nonNegativeInt,
    useContextResonance: z.boolean(),
    associationStrength: proportion,
    compressionThreshold: positiveInt,
    cueBudgetMs: positiveInt,
    tokenBudget: positiveInt,
    minRelevance: proportion,
    /**
     * Not an Appendix E parameter. Entity resolution's fuzzy leg needs a name-similarity floor
     * of its own; borrowing `contextResonance.contextSearchThreshold` would make one env var
     * mean two unrelated things once Algorithm 3 lands.
     */
    entityMatchThreshold: proportion,
  }),
  search: z.object({
    methods: z.array(searchMethod).min(1),
    reranker: z.enum(['rrf', 'mmr']),
    rrfConstant: positiveInt,
    mmrLambda: proportion,
    weights: z.object({
      vector: proportion,
      bm25: proportion,
      graph: proportion,
    }),
  }),
  activation: z.object({
    maxIterations: positiveInt,
    decayFactor: proportion,
    minActivation: proportion,
    maxNodesVisited: positiveInt,
    hubThreshold: positiveInt,
  }),
  hebbian: z.object({
    weightFloor: proportion,
    learningRate: proportion,
    decayRate: proportion,
    decayPeakDays: positiveInt,
    decaySigma: z.number().positive(),
    batchSize: positiveInt,
    flushIntervalMs: positiveInt,
  }),
  contextResonance: z.object({
    seedLimit: positiveInt,
    activationLimit: positiveInt,
    resonantLimit: positiveInt,
    maxHops: nonNegativeInt,
    activationThreshold: proportion,
    contextSearchThreshold: proportion,
  }),
  /**
   * The reflection pipeline's per-stage knobs. Each stage owns its own thresholds and caps as
   * an options type and carries the pinned default as a module constant; these are what the
   * service threads over them at construction, so the shipped values live in one catalog
   * rather than in nine files. The three timeouts are hang guards on `provider.generate`,
   * not latency targets: reflection is asynchronous and the value that matters is that a
   * model which never answers cannot hold the worker forever.
   */
  reflection: z.object({
    entityTimeoutMs: positiveInt,
    maxEntities: positiveInt,
    entityDedupThreshold: proportion,
    associationSemanticThreshold: proportion,
    associationSimilarLimit: positiveInt,
    cognitiveTimeoutMs: positiveInt,
    maxCognitiveNodes: positiveInt,
    semanticTimeoutMs: positiveInt,
    maxRelationships: positiveInt,
    supersedeAutoConfidence: proportion,
    supersedeNeighborThreshold: proportion,
    supersedeTimeoutMs: positiveInt,
    maxSupersessionSubjects: positiveInt,
    maxContradictionNeighbors: positiveInt,
    maxContradictionJudgments: positiveInt,
    /** Minutes, because that is the unit the pinned trigger is stated in (30 min idle). */
    narrativeIdleMinutes: positiveInt,
    narrativeTimeoutMs: positiveInt,
    maxNarrativeEpisodes: positiveInt,
    maxNarrativeEpisodeChars: positiveInt,
    narrativeSweepLimit: positiveInt,
  }),
  /**
   * The arrival-rate backstop behind the reflection queue's priority lanes. The explicit
   * `lane` input is what normally decides; these bound the damage a client that floods
   * without setting it can do to everyone else's freshness.
   */
  lanes: z.object({
    arrivalWindowMs: positiveInt,
    sessionArrivalMax: positiveInt,
    globalArrivalMax: positiveInt,
    hotSessionArrivalMax: positiveInt,
  }),
  redaction: z.object({
    /** Shannon entropy in bits/char above which an unmatched token is still flagged as a likely secret. */
    entropyThreshold: z.number().positive(),
  }),
  maintenance: z.object({
    tier3: z.boolean(),
  }),
  sqlite: z.object({
    path: z.string().min(1),
    /** Rows past this are dropped oldest-first at enqueue; the table has no consumer until P4. */
    reinforcementQueueCap: positiveInt,
  }),
  operational: z.object({
    dataDir: z.string().min(1),
    mcpPort: z.number().int().min(1).max(65535),
    workerCount: positiveInt,
    /** How long a claim outlives the process that took it before the next drain reclaims it. */
    workerStaleClaimTimeoutMs: positiveInt,
    workerRetryBaseMs: positiveInt,
    workerRetryCapMs: positiveInt,
    workerMaxAttempts: positiveInt,
    workerBreakerThreshold: positiveInt,
    workerBreakerCooldownMs: positiveInt,
    workerVectorBatchSize: positiveInt,
    /** Unenriched episodes `aion doctor` reports as a warning rather than a count. */
    reconcileWarnThreshold: nonNegativeInt,
  }),
  logging: z.object({
    filePath: z.string().min(1),
    level: z.enum(LOG_LEVELS),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;
