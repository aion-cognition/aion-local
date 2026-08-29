import { describe, expect, it } from 'vitest';
import { LOG_FILE_ENV_VAR, LOG_LEVEL_ENV_VAR } from '../logging/logger.js';
import { DEFAULTS } from './defaults.js';
import { ConfigError, loadConfig } from './load-config.js';

describe('loadConfig defaults', () => {
  it('returns the built-in defaults when no AION_* vars are set', () => {
    expect(loadConfig({})).toEqual(DEFAULTS);
  });

  it('ignores non-AION_* env vars entirely', () => {
    expect(loadConfig({ PATH: '/usr/bin', HOME: '/root' })).toEqual(DEFAULTS);
  });

  // Both differ from the smaller candidate value, so each is pinned here: a silent drift
  // back to 5 hides traversal-reached items again, and back to 2000 degrades a warm recall.
  it('serves the raised episode cap and cue budget, not the smaller defaults', () => {
    const config = loadConfig({});

    expect(config.recall.maxEpisodes).toBe(20);
    expect(config.recall.cueBudgetMs).toBe(8000);
  });

  // The traversal cutoff above the decay floor is the shape that made the floor inert: decay
  // clamps a weight at the floor so a faded path stays reachable, and a cutoff above it severs
  // exactly the band the clamp protects, while every operator surface still reads the edge as
  // present. The two numbers are set apart, so the relation between them is pinned here.
  it('keeps the traversal cutoff at or under the weight decay clamps to', () => {
    const config = loadConfig({});

    expect(config.recall.associationStrength).toBeLessThanOrEqual(config.hebbian.weightFloor);
  });

  it('never mutates the shared DEFAULTS object across calls', () => {
    const before = DEFAULTS.recall.maxHops;

    loadConfig({ AION_RECALL_MAX_HOPS: '9' });

    expect(DEFAULTS.recall.maxHops).toBe(before);
    expect(DEFAULTS.recall.maxHops).not.toBe(9);
  });
});

describe('loadConfig override precedence', () => {
  it('overrides a string leaf', () => {
    const config = loadConfig({ AION_NEO4J_URI: 'bolt://127.0.0.1:7687' });
    expect(config.neo4j.uri).toBe('bolt://127.0.0.1:7687');
    expect(config.neo4j.password).toBe(DEFAULTS.neo4j.password);
  });

  it('overrides a number leaf', () => {
    const config = loadConfig({ AION_CUE_BUDGET_MS: '5000' });
    expect(config.recall.cueBudgetMs).toBe(5000);
  });

  it('overrides a boolean leaf', () => {
    const config = loadConfig({ AION_MAINTENANCE_TIER3: 'true' });
    expect(config.maintenance.tier3).toBe(true);
  });

  it('overrides an enum-backed string leaf', () => {
    const config = loadConfig({ AION_OLLAMA_MODE: 'docker', AION_SEARCH_RERANKER: 'mmr' });
    expect(config.ollama.mode).toBe('docker');
    expect(config.search.reranker).toBe('mmr');
  });

  it('overrides the comma-separated search weights as vector,bm25,graph', () => {
    const config = loadConfig({ AION_SEARCH_WEIGHTS: '0.5,0.25,0.25' });
    expect(config.search.weights).toEqual({ vector: 0.5, bm25: 0.25, graph: 0.25 });
  });

  it('overrides a comma-separated string list', () => {
    const config = loadConfig({ AION_SEARCH_METHODS: 'vector, bm25' });
    expect(config.search.methods).toEqual(['vector', 'bm25']);
  });

  it('routes logging overrides through the shared logger env var names', () => {
    const config = loadConfig({ [LOG_FILE_ENV_VAR]: '/tmp/aion.jsonl', [LOG_LEVEL_ENV_VAR]: 'debug' });
    expect(config.logging).toEqual({ filePath: '/tmp/aion.jsonl', level: 'debug' });
  });

  it('applies many overrides independently of each other', () => {
    const config = loadConfig({
      AION_EMBED_MODEL: 'custom-embed',
      AION_HEBBIAN_LEARNING_RATE: '0.2',
      AION_MCP_PORT: '9000',
    });
    expect(config.models.embed).toBe('custom-embed');
    expect(config.hebbian.learningRate).toBe(0.2);
    expect(config.operational.mcpPort).toBe(9000);
    expect(config.recall).toEqual(DEFAULTS.recall);
  });
});

describe('loadConfig bad values', () => {
  it('rejects a non-numeric value for a numeric leaf, naming the var', () => {
    expect(() => loadConfig({ AION_RECALL_MAX_HOPS: 'not-a-number' })).toThrow(ConfigError);
    expect(() => loadConfig({ AION_RECALL_MAX_HOPS: 'not-a-number' })).toThrow(/AION_RECALL_MAX_HOPS/);
  });

  it('rejects an out-of-range proportion, naming the var', () => {
    expect(() => loadConfig({ AION_VECTOR_ADMISSION_FLOOR: '1.5' })).toThrow(/AION_VECTOR_ADMISSION_FLOOR/);
  });

  it('rejects a value outside its enum, naming the var', () => {
    expect(() => loadConfig({ AION_OLLAMA_MODE: 'remote' })).toThrow(/AION_OLLAMA_MODE/);
  });

  it('rejects a non-boolean string for a boolean leaf, naming the var', () => {
    expect(() => loadConfig({ AION_MAINTENANCE_TIER3: 'yes' })).toThrow(/AION_MAINTENANCE_TIER3/);
  });

  it('rejects search weights with the wrong number of parts', () => {
    expect(() => loadConfig({ AION_SEARCH_WEIGHTS: '0.5,0.5' })).toThrow(/AION_SEARCH_WEIGHTS/);
  });

  it('rejects search weights with a non-numeric part', () => {
    expect(() => loadConfig({ AION_SEARCH_WEIGHTS: '0.5,x,0.2' })).toThrow(/AION_SEARCH_WEIGHTS/);
  });

  it('reports every bad var in one error when several are invalid', () => {
    let caught: unknown;
    try {
      loadConfig({ AION_RECALL_MAX_HOPS: 'bad', AION_VECTOR_ADMISSION_FLOOR: '9' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const message = (caught as ConfigError).message;
    expect(message).toMatch(/AION_RECALL_MAX_HOPS/);
    expect(message).toMatch(/AION_VECTOR_ADMISSION_FLOOR/);
  });
});

describe('loadConfig unknown vars', () => {
  it('rejects an AION_* var with no matching knob', () => {
    expect(() => loadConfig({ AION_NOT_A_REAL_KNOB: '1' })).toThrow(ConfigError);
    expect(() => loadConfig({ AION_NOT_A_REAL_KNOB: '1' })).toThrow(/AION_NOT_A_REAL_KNOB/);
  });

  it('lists every unknown var, sorted, in one error', () => {
    let caught: unknown;
    try {
      loadConfig({ AION_ZEBRA: '1', AION_APPLE: '2' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).message).toBe(
      'Unknown AION_* environment variable(s): AION_APPLE, AION_ZEBRA',
    );
  });

  it('does not flag AION_-prefixed vars that are merely undefined', () => {
    expect(() => loadConfig({ AION_NEO4J_URI: undefined })).not.toThrow();
  });

  it('accepts the wrapper transport vars bin/aion passes into the container', () => {
    expect(() =>
      loadConfig({ AION_REPO_PATH: '/Users/x/aion-local', AION_GIT_USER_NAME: 'Ryan Huber' }),
    ).not.toThrow();
  });
});

describe('loadConfig sqlite', () => {
  it('defaults the database to the aion-data volume', () => {
    expect(loadConfig({}).sqlite.path).toBe('/data/aion.sqlite');
  });

  it('takes AION_SQLITE_PATH as an override', () => {
    expect(loadConfig({ AION_SQLITE_PATH: '/tmp/aion.sqlite' }).sqlite.path).toBe('/tmp/aion.sqlite');
  });
});
