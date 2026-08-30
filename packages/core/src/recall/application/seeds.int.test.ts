import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { selectSeeds, type Seed, type SeedCue, type SelectSeedsDeps } from './seeds.js';
import { waitFor } from './test-support/wait-for.fixture.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import type { Config } from '../../infrastructure/config/schema.js';
import { bootstrapBackbone } from '../../infrastructure/graph/backbone.js';
import { supersede, writeStampedNode } from '../../infrastructure/graph/bitemporal.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import { asOf, withCurrency } from '../../infrastructure/graph/read-modes.js';
import {
  countMemoryNodes,
  entitySimilaritySeeds,
  fulltextSeeds,
  vectorSeeds,
} from '../../infrastructure/graph/seed-queries.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger, type Logger } from '../../infrastructure/logging/logger.js';
import { openSqliteHandle, type SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { seedBudget } from '../domain/seed-selection.js';

const EMBED_DIMENSION = 8;
const WRITTEN_AT = new Date('2026-08-01T00:00:00.000Z');
const SUPERSEDED_AT = new Date('2026-08-10T00:00:00.000Z');
const BETWEEN = new Date('2026-08-05T00:00:00.000Z');
const ACCESSED_AT = new Date('2026-08-20T00:00:00.000Z');

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let logger: Logger;
let memberId: string;
let workspaceId: string;

const ids = {
  claimPath: '',
  activation: '',
  turn: '',
  oldTruth: '',
  newTruth: '',
  forgotten: '',
};

function axis(index: number): number[] {
  const vector = new Array<number>(EMBED_DIMENSION).fill(0);
  vector[index] = 1;
  return vector;
}

const VECTORS = {
  claimPath: axis(0),
  activation: axis(1),
  turn: axis(2),
  truth: axis(3),
  forgotten: axis(4),
  entityName: axis(5),
};

function config(overrides: Partial<Config['contextResonance']> = {}): Config {
  return {
    ...DEFAULTS,
    contextResonance: { ...DEFAULTS.contextResonance, seedLimit: 8, ...overrides },
  };
}

function deps(overrides: Partial<Config['contextResonance']> = {}): SelectSeedsDeps {
  return { driver: harness.driver, config: config(overrides), logger };
}

function cue(text: string, weight: 3 | 2 | 1, vector?: readonly number[]): SeedCue {
  const base = { text, source: 'query' as const, weight };
  return vector === undefined ? base : { ...base, vector };
}

function find(seeds: readonly Seed[], id: string): Seed | undefined {
  return seeds.find((seed) => seed.id === id);
}

/** Vector and fulltext indexes populate asynchronously, so the fixture is not queryable the instant it is written. */
async function writeEpisode(
  summary: string,
  vector: readonly number[],
  extra: Record<string, unknown> = {},
  at: Date = WRITTEN_AT,
): Promise<string> {
  const result = await writeStampedNode(harness.driver, {
    label: 'Episode',
    occurredAt: at,
    now: at,
    properties: { summary, content_vec: [...vector], ...extra },
  });
  return result.id;
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-seeds-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'debug' });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  const backbone = await bootstrapBackbone(harness.driver, { memberName: 'Ryan Huber' });
  memberId = backbone.member.id;
  workspaceId = backbone.workspace.id;

  ids.claimPath = await writeEpisode(
    'the reflection queue claim path retries after SQLITE_BUSY',
    VECTORS.claimPath,
  );
  ids.activation = await writeEpisode(
    'spreading activation over batched adjacency fetches',
    VECTORS.activation,
    {
      last_accessed: ACCESSED_AT,
    },
  );
  ids.oldTruth = await writeEpisode('the seed limit was five', VECTORS.truth);
  // The correction happens on the supersession date, so a read pinned between the two has a
  // world in which only the old truth exists yet.
  ids.newTruth = await writeEpisode('the seed limit is ten', VECTORS.truth, {}, SUPERSEDED_AT);
  ids.forgotten = await writeEpisode('a forgotten episode about claim paths', VECTORS.forgotten, {
    forgotten_at: SUPERSEDED_AT,
  });

  const turn = await writeStampedNode(harness.driver, {
    label: 'Turn',
    occurredAt: WRITTEN_AT,
    now: WRITTEN_AT,
    properties: {
      text: 'bitemporal supersession never deletes a node',
      content_vec: [...VECTORS.turn],
    },
  });
  ids.turn = turn.id;

  await supersede(harness.driver, {
    oldId: ids.oldTruth,
    newId: ids.newTruth,
    now: SUPERSEDED_AT,
  });

  // Probed through the query functions rather than `selectSeeds`, which isolates a failing
  // strategy and would hide a broken query behind an empty contribution.
  await waitFor('the vector index to cover every fixture memory node', async () => {
    const rows = await vectorSeeds(harness.driver, {
      vector: VECTORS.claimPath,
      limit: 50,
      mode: withCurrency(),
    });
    return rows.length >= 5;
  });

  await waitFor('the fulltext index to cover the fixture episodes', async () => {
    const rows = await fulltextSeeds(harness.driver, {
      query: 'SQLITE_BUSY',
      limit: 50,
      mode: withCurrency(),
    });
    return rows.some((row) => row.id === ids.claimPath);
  });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('per-strategy hits', () => {
  it('vector search ranks the nearest content vector first for the cue that was embedded', async () => {
    const selection = await selectSeeds(deps(), {
      cues: [cue('how does activation spread', 3, VECTORS.activation)],
    });
    expect(selection.byStrategy.vector[0]?.id).toBe(ids.activation);
    expect(selection.byStrategy.vector[0]?.score).toBeCloseTo(1, 5);
  });

  it('reports a true cosine, so the relevance floor is measured against what it names', async () => {
    const rows = await vectorSeeds(harness.driver, {
      vector: VECTORS.activation,
      limit: 50,
      mode: withCurrency(),
    });

    // Neo4j hands back `(1 + cos) / 2`, which would put every orthogonal memory at 0.5, right
    // at `AION_VECTOR_ADMISSION_FLOOR`, and so no floor at all.
    expect(rows.find((row) => row.id === ids.activation)?.score).toBeCloseTo(1, 5);
    expect(rows.find((row) => row.id === ids.claimPath)?.score).toBeCloseTo(0, 5);
    expect(rows.find((row) => row.id === ids.claimPath)?.score).toBeLessThan(
      DEFAULTS.recall.vectorAdmissionFloor,
    );
  });

  it('BM25 finds the exact token a paraphrase would miss', async () => {
    const selection = await selectSeeds(deps(), { cues: [cue('SQLITE_BUSY', 3)] });
    const seed = find(selection.byStrategy.bm25, ids.claimPath);
    expect(seed?.provenance[0]).toMatchObject({ strategy: 'bm25', cue: 'SQLITE_BUSY' });
    expect(seed?.score).toBeGreaterThan(0);
  });

  it('entity resolution matches a structural entity by exact normalized name', async () => {
    const selection = await selectSeeds(deps(), { cues: [cue('  Ryan   HUBER ', 3)] });
    const seed = find(selection.byStrategy.entity_resolution, memberId);
    expect(seed?.provenance[0]).toMatchObject({ strategy: 'entity_resolution', score: 1 });
    expect(seed?.content).toBe('Ryan Huber');
  });

  it('recency puts the node with last_accessed ahead of the merely new ones', async () => {
    const selection = await selectSeeds(deps(), { cues: [cue('anything at all', 1)] });
    expect(selection.byStrategy.recency[0]?.id).toBe(ids.activation);
    expect(selection.byStrategy.recency[0]?.score).toBe(1);
    expect(selection.byStrategy.recency.map((seed) => seed.id)).toContain(ids.turn);
  });

  it('scales a strategy score by the weight of the cue behind it', async () => {
    const heavy = await selectSeeds(deps(), { cues: [cue('turns', 3, VECTORS.turn)] });
    const light = await selectSeeds(deps(), { cues: [cue('turns', 1, VECTORS.turn)] });
    const heavyScore = find(heavy.byStrategy.vector, ids.turn)?.score ?? 0;
    const lightScore = find(light.byStrategy.vector, ids.turn)?.score ?? 0;
    expect(lightScore).toBeCloseTo(heavyScore / 3, 5);
  });
});

describe('entity resolution before any name embeddings are written', () => {
  /** Runs before the test that writes a `name_vec`, which is the only thing that changes this answer. */
  it('returns nothing from the similarity leg and raises no error when no entity carries a name embedding', async () => {
    const rows = await entitySimilaritySeeds(harness.driver, {
      vector: VECTORS.entityName,
      threshold: DEFAULTS.recall.entityMatchThreshold,
      limit: 10,
      mode: withCurrency(),
    });
    expect(rows).toEqual([]);
  });

  it('still selects seeds, so a cold-start graph degrades to the other three strategies', async () => {
    const selection = await selectSeeds(deps(), {
      cues: [cue('aion', 3, VECTORS.entityName)],
    });
    expect(selection.seeds.length).toBeGreaterThan(0);
    expect(selection.byStrategy.entity_resolution).toEqual([]);
  });
});

describe('bitemporal read mode composition', () => {
  it('surfaces a superseded node annotated with its lineage rather than filtering it out', async () => {
    const selection = await selectSeeds(deps(), {
      cues: [cue('the seed limit', 3, VECTORS.truth)],
    });

    const old = find(selection.seeds, ids.oldTruth);
    expect(old?.currency).toBe('superseded');
    expect(old?.supersededBy?.id).toBe(ids.newTruth);
    expect(find(selection.seeds, ids.newTruth)?.currency).toBe('current');
  });

  it('suppresses a forget-closed node on every strategy', async () => {
    const selection = await selectSeeds(deps({ seedLimit: 50 }), {
      cues: [cue('claim paths', 3, VECTORS.forgotten)],
    });

    expect(find(selection.seeds, ids.forgotten)).toBeUndefined();
    for (const strategy of ['vector', 'bm25', 'entity_resolution', 'recency'] as const) {
      expect(find(selection.byStrategy[strategy], ids.forgotten)).toBeUndefined();
    }
  });

  it('as_of returns the old truth as current-for-then and hides the correction that had not happened', async () => {
    const selection = await selectSeeds(deps({ seedLimit: 50 }), {
      cues: [cue('the seed limit', 3, VECTORS.truth)],
      mode: asOf(BETWEEN),
    });

    expect(find(selection.seeds, ids.oldTruth)?.currency).toBe('current');
    expect(find(selection.seeds, ids.newTruth)).toBeUndefined();
  });
});

describe('merge', () => {
  it('keeps one seed per node carrying every strategy that found it, best score first', async () => {
    const selection = await selectSeeds(deps(), {
      cues: [cue('SQLITE_BUSY', 3, VECTORS.claimPath)],
    });

    const seed = find(selection.seeds, ids.claimPath);
    expect(seed).toBeDefined();
    expect(selection.seeds.filter((entry) => entry.id === ids.claimPath)).toHaveLength(1);

    const strategies = seed?.provenance.map((entry) => entry.strategy) ?? [];
    expect(strategies).toContain('vector');
    expect(strategies).toContain('bm25');
    expect(strategies).toContain('recency');

    const scores = seed?.provenance.map((entry) => entry.score) ?? [];
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    expect(seed?.score).toBe(scores[0]);
  });

  it('cuts the merged set to the configured seed limit', async () => {
    const selection = await selectSeeds(deps({ seedLimit: 2 }), {
      cues: [cue('the seed limit', 3, VECTORS.truth), cue('global', 2)],
    });
    expect(selection.seeds).toHaveLength(2);
  });

  it('resolves a name to a structural workspace entity alongside the content hit on the same name', async () => {
    const selection = await selectSeeds(deps(), { cues: [cue('global', 3)] });
    const seed = find(selection.seeds, workspaceId);
    // `exact` because a normalized-name match is an identity match, which admission reads as
    // evidence rather than as a score to measure against the cosine floor.
    expect(seed?.provenance).toContainEqual({
      strategy: 'entity_resolution',
      score: 1,
      relevance: 1,
      exact: true,
      cue: 'global',
    });
    expect(seed?.provenance.map((entry) => entry.strategy)).toContain('bm25');
    expect(seed?.isStructural).toBe(true);
  });
});

describe('the seed budget the substrate earns', () => {
  it('is read from the memory nodes the graph holds rather than from a fixed number', async () => {
    const population = await countMemoryNodes(harness.driver);
    const selection = await selectSeeds(deps({ seedLimit: DEFAULTS.contextResonance.seedLimit }), {
      cues: [cue('the seed limit', 3, VECTORS.truth)],
    });

    expect(population).toBeGreaterThan(0);
    expect(selection.budget).toBe(
      seedBudget(population, {
        base: DEFAULTS.contextResonance.seedBudgetBase,
        growth: DEFAULTS.contextResonance.seedBudgetGrowth,
        cap: DEFAULTS.contextResonance.seedLimit,
      }),
    );
    expect(selection.budget).toBeGreaterThan(DEFAULTS.contextResonance.seedBudgetBase);
  });

  it('stops at a pinned seed limit, which is the cap on the curve', async () => {
    const selection = await selectSeeds(deps({ seedLimit: 2 }), {
      cues: [cue('the seed limit', 3, VECTORS.truth)],
    });

    expect(selection.budget).toBe(2);
    expect(selection.seeds).toHaveLength(2);
  });
});

describe('entity name similarity once name embeddings exist', () => {
  it('matches an entity above the similarity threshold once a name embedding exists', async () => {
    const entity = await writeStampedNode(harness.driver, {
      label: 'Entity',
      occurredAt: WRITTEN_AT,
      now: WRITTEN_AT,
      properties: {
        type: 'project',
        name: 'Aion',
        name_norm: 'aion',
        name_vec: [...VECTORS.entityName],
      },
    });

    const rows = await entitySimilaritySeeds(harness.driver, {
      vector: VECTORS.entityName,
      threshold: DEFAULTS.recall.entityMatchThreshold,
      limit: 10,
      mode: withCurrency(),
    });

    expect(rows.map((row) => row.id)).toEqual([entity.id]);
    // An identical vector is cosine 1, not Neo4j's rescaled 1; the conversion is what makes
    // the threshold a cosine.
    expect(rows[0]?.score).toBeCloseTo(1, 5);

    const selection = await selectSeeds(deps(), {
      cues: [cue('the aion substrate', 3, VECTORS.entityName)],
    });
    const seed = find(selection.byStrategy.entity_resolution, entity.id);
    expect(seed?.provenance[0]?.strategy).toBe('entity_resolution');
  });

  it('leaves an entity below the threshold out', async () => {
    const rows = await entitySimilaritySeeds(harness.driver, {
      vector: VECTORS.turn,
      threshold: DEFAULTS.recall.entityMatchThreshold,
      limit: 10,
      mode: withCurrency(),
    });
    expect(rows).toEqual([]);
  });
});
