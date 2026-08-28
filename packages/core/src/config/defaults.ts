import { DEFAULT_LOG_FILE, DEFAULT_LOG_LEVEL } from '../logging/logger.js';
import { DEFAULT_SQLITE_PATH } from '../sqlite/database.js';
import type { Config } from './schema.js';

/**
 * Values are PRD §14 / whitepaper Appendix E defaults where either doc pins one.
 * `redaction.entropyThreshold` and `operational.dataDir` are not pinned by either doc;
 * they follow common secret-scanner practice (4.5 bits/char) and the compose data
 * volume mount point respectively. `operational.workerCount` is pinned at 1 by PRD §7
 * ("one worker by default").
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
    maxHops: 2,
    vectorLimit: 5,
    maxFacts: 15,
    maxEpisodes: 5,
    maxNarratives: 5,
    maxPreferences: 3,
    maxResonant: 5,
    useContextResonance: true,
    associationStrength: 0.5,
    compressionThreshold: 512,
    cueBudgetMs: 2000,
    tokenBudget: 1200,
    minRelevance: 0.35,
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
  redaction: {
    entropyThreshold: 4.5,
  },
  maintenance: {
    tier3: false,
  },
  sqlite: {
    path: DEFAULT_SQLITE_PATH,
  },
  operational: {
    dataDir: '/data',
    mcpPort: 8765,
    workerCount: 1,
  },
  logging: {
    filePath: DEFAULT_LOG_FILE,
    level: DEFAULT_LOG_LEVEL,
  },
};
