import { z } from 'zod';
import { LOG_LEVELS } from '../logging/logger.js';

/**
 * Range constraints below match a specific pinned value where one exists; the rest
 * (int/positive/0-1) are defensive shape checks, not tuned limits.
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
    /**
     * Absolute cosine floors, measured against the embedding model's noise rather than pinned
     * defaults. `floor-calibration.int.test.ts` measures both distributions and fails when the
     * committed value stops separating them. `vectorAdmissionFloor` admits one measurement
     * alone; `corroborationFloor` is the lower bar a measurement has to clear to count as one
     * of the two an item can be corroborated in on.
     */
    vectorAdmissionFloor: proportion,
    corroborationFloor: proportion,
    /** A Lucene score is corpus-relative, so the lexical leg admits by rule, not by number. */
    bm25AdmissionMode: z.enum(['exact', 'corroborated', 'any']),
    /**
     * Entity resolution's fuzzy leg needs a name-similarity floor of its own; borrowing
     * `contextResonance.contextSearchThreshold` would make one env var mean two unrelated
     * things once the fuzzy matcher lands.
     */
    entityMatchThreshold: proportion,
    /**
     * A near-duplicate cluster's cap on how many of its members one bucket may hold (
     * a burst of near-identical episodes took 29.5% of a pack's slots). Defaults to 2 and is
     * set by `AION_PACK_CLUSTER_CAP`.
     */
    clusterCap: positiveInt,
    /**
     * The facts bucket's own three rules (entity glosses took 58% of fact slots and
     * Decision nodes 3% on a decision-oriented workload). `entityGlossCap` bounds the glosses;
     * `restatementFloor` is the cosine at or above which a Goal or Plan is judged to be the
     * query said back rather than answered, measured in `facts-calibration.int.test.ts`;
     * `decisionBoost` multiplies the fused score of Decision and Insight when the cue model
     * judged the query decision-shaped.
     */
    entityGlossCap: positiveInt,
    restatementFloor: proportion,
    decisionBoost: z.number().min(1),
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
    /**
     * The ceiling on the seed budget rather than the budget itself. The budget is
     * `seedBudgetBase + seedBudgetGrowth * ln(memory nodes)`, so this is what a substrate
     * large enough to reach it settles at, and pinning it low pins the budget outright.
     */
    seedLimit: positiveInt,
    seedBudgetBase: positiveInt,
    seedBudgetGrowth: z.number().positive(),
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
    /**
     * `propose` writes every detection to `supersession_proposals` and never closes a node;
     * `auto` restores the confidence split. Auto returns only once the quality harness
     * measures precision on the contradiction battery, so the default is the safe one.
     */
    supersedeMode: z.enum(['propose', 'auto']),
    /** The auto path's threshold only. In `propose` mode nothing reads it. */
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
    /** How often the introspection loop observes, decides, and runs at most one operation. */
    tickMinutes: positiveInt,
    /** Cycles of being passed over that double an operation's urgency; the anti-starvation span. */
    starvationCycles: positiveInt,
    /** Urgency a routine operation must reach before the loop will run it at all. */
    urgencyThreshold: proportion,
    /** Effectiveness under which an operation is weighted down, never excluded. */
    effectivenessFloor: proportion,
  }),
  sqlite: z.object({
    path: z.string().min(1),
    /** Rows past this are dropped oldest-first at enqueue; the table has no consumer yet. */
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
    /** `aion doctor`'s `queue-lag` check warns past this age; no gauge existed at all before it. */
    lagOldestUnclaimedWarnMs: positiveInt,
    /** `aion doctor`'s `queue-lag` check warns past this total unclaimed depth. */
    lagQueueDepthWarnThreshold: nonNegativeInt,
    /**
     * A client's `close()` tears down its transport locally without a DELETE, so the
     * server-side session-close hook fires only when a client sends one. This is the trigger
     * that does not depend on that: an MCP transport session with no request in this many
     * minutes closes on its own, independent of DELETE.
     */
    sessionIdleExpiryMinutes: positiveInt,
  }),
  logging: z.object({
    filePath: z.string().min(1),
    level: z.enum(LOG_LEVELS),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;
