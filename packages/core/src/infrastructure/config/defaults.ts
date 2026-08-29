import { DEFAULT_LOG_FILE, DEFAULT_LOG_LEVEL } from '../logging/logger.js';
import { DEFAULT_SQLITE_PATH } from '../sqlite/database.js';
import { DEFAULT_REINFORCEMENT_QUEUE_CAP } from '../sqlite/reinforcement-queue.js';
import type { Config } from './schema.js';

/**
 * Values are PRD §14 / whitepaper Appendix E defaults where either doc pins one.
 * `redaction.entropyThreshold` and `operational.dataDir` are not pinned by either doc;
 * they follow common secret-scanner practice (4.5 bits/char) and the compose data
 * volume mount point respectively. `operational.workerCount` is pinned at 1 by PRD §7
 * ("one worker by default"). Three values depart from their pinned defaults; each says why
 * at the line.
 *
 * Reserved knobs: `recall.useContextResonance`, `recall.compressionThreshold`,
 * `contextResonance.{resonantLimit,maxHops,activationThreshold,contextSearchThreshold}`,
 * `hebbian.*` and `maintenance.tier3` are declared and overridable but have no reader until
 * the phase that produces them (context resonance, narrative compression, plasticity flush,
 * tier-3 maintenance). They are declared now because the catalog is one document and a knob
 * that appears late is a knob whose name and range were never reviewed; setting one today
 * changes nothing.
 */
export const DEFAULTS: Config = {
  neo4j: {
    uri: 'bolt://neo4j:7687',
    password: '',
  },
  ollama: {
    url: 'http://host.docker.internal:11434',
    mode: 'baremetal',
  },
  models: {
    embed: 'nomic-embed-text',
    embedDimension: 768,
    cue: 'qwen3:1.7b',
    reflect: 'qwen3:8b',
  },
  anthropic: {
    apiKey: '',
  },
  recall: {
    // Appendix E pins 2. Raised because P2's graph routes every cross-session path through a
    // Session hub — Episode -PARTICIPATES_IN-> Session -FOLLOWS-> Session -PARTICIPATES_IN->
    // Episode is three hops — so at 2 the FOLLOWS chain reaches nothing but a contentless
    // Session node. Appendix E's own resonance spread uses 3 for the same reason.
    maxHops: 3,
    vectorLimit: 5,
    maxFacts: 15,
    // Appendix E pins 5. Raised because the cap cuts the fused list, so it decides what
    // survives fusion competition rather than how big a pack gets: on a populated substrate
    // (~40 episodes) near-tie vector hits fill the first five and the one traversal-reached
    // item ranked 13th, absent at 5, 8, and 12 and present at 20. Activation runs on every
    // recall either way; the cap is what decides whether the caller sees what it found. The
    // token budget, not this number, is what actually bounds a pack.
    maxEpisodes: 20,
    maxNarratives: 5,
    maxPreferences: 3,
    maxResonant: 5,
    useContextResonance: true,
    associationStrength: 0.5,
    compressionThreshold: 512,
    // PRD §14 pins 2000. Raised because that is under the pinned cue model's cold-start
    // round trip (2288ms measured on host Ollama against 527-937ms warm), and a guard that
    // fires on the first recall after a model eviction degrades the stage it exists to
    // protect. Raised again to 8000 after a live gate rerun busted 2000 at 2030ms on an
    // ordinary recall: warm cue latency runs 558-811ms, so the headroom a cold start needs
    // is several multiples of the warm case. Still a hang guard: the failure this catches
    // is a call that never returns.
    cueBudgetMs: 8000,
    tokenBudget: 1200,
    minRelevance: 0.35,
    entityMatchThreshold: 0.7,
  },
  search: {
    methods: ['vector', 'bm25', 'graph_traversal'],
    reranker: 'rrf',
    rrfConstant: 60,
    mmrLambda: 0.5,
    weights: {
      vector: 0.4,
      bm25: 0.3,
      graph: 0.3,
    },
  },
  activation: {
    maxIterations: 100,
    decayFactor: 0.7,
    minActivation: 0.1,
    maxNodesVisited: 500,
    hubThreshold: 10,
  },
  hebbian: {
    weightFloor: 0.1,
    learningRate: 0.1,
    decayRate: 0.05,
    decayPeakDays: 30,
    decaySigma: 15,
    batchSize: 100,
    flushIntervalMs: 5000,
  },
  contextResonance: {
    seedLimit: 10,
    activationLimit: 50,
    resonantLimit: 20,
    maxHops: 3,
    activationThreshold: 0.1,
    contextSearchThreshold: 0.7,
  },
  /**
   * Every value is the pinned default its stage already carries as a module constant, and
   * `reflection-defaults.test.ts` asserts the two agree: config is where a knob is named and
   * ranged, the stage is where it is used, and a silent divergence between them would ship a
   * pipeline nobody configured. Two are pinned by the plan rather than by a stage author,
   * `supersedeAutoConfidence` (0.85) and `associationSemanticThreshold` (0.75).
   */
  reflection: {
    entityTimeoutMs: 60_000,
    maxEntities: 32,
    entityDedupThreshold: 0.85,
    associationSemanticThreshold: 0.75,
    associationSimilarLimit: 5,
    cognitiveTimeoutMs: 60_000,
    maxCognitiveNodes: 20,
    semanticTimeoutMs: 60_000,
    maxRelationships: 40,
    supersedeAutoConfidence: 0.85,
    supersedeNeighborThreshold: 0.75,
    supersedeTimeoutMs: 60_000,
    maxSupersessionSubjects: 6,
    maxContradictionNeighbors: 3,
    maxContradictionJudgments: 8,
    narrativeIdleMinutes: 30,
    narrativeTimeoutMs: 60_000,
    maxNarrativeEpisodes: 40,
    maxNarrativeEpisodeChars: 2_000,
    narrativeSweepLimit: 20,
  },
  redaction: {
    entropyThreshold: 4.5,
  },
  maintenance: {
    tier3: false,
  },
  sqlite: {
    path: DEFAULT_SQLITE_PATH,
    reinforcementQueueCap: DEFAULT_REINFORCEMENT_QUEUE_CAP,
  },
  operational: {
    dataDir: '/data',
    mcpPort: 8765,
    workerCount: 1,
    workerStaleClaimTimeoutMs: 600_000,
    workerRetryBaseMs: 5_000,
    workerRetryCapMs: 300_000,
    workerMaxAttempts: 5,
    workerBreakerThreshold: 5,
    workerBreakerCooldownMs: 60_000,
    workerVectorBatchSize: 64,
  },
  logging: {
    filePath: DEFAULT_LOG_FILE,
    level: DEFAULT_LOG_LEVEL,
  },
};
