import type { Driver } from 'neo4j-driver';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ContextVectorStage } from './context-vectors.js';
import { writeStampedNode } from '../../../infrastructure/graph/bitemporal.js';
import { upsertEdge } from '../../../infrastructure/graph/edges.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import {
  contextVector,
  vectorIndexNeighbors,
} from '../../../infrastructure/graph/test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger, type Logger } from '../../../infrastructure/logging/logger.js';
import type { Provider } from '../../../infrastructure/providers/types.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import type { StageContext } from '../../domain/stage.js';
import { PIPELINE_VERSION } from '../../domain/version.js';

/**
 * A small hand-built neighborhood rather than a full LLM enrichment: this stage is pure
 * graph math with no provider call, so what needs proving live is the Cypher and the vector
 * index, not extraction quality. `EMBED_DIMENSION` stays small so the fixture vectors are
 * readable by eye; the index itself is dimension-agnostic.
 */
const EMBED_DIMENSION = 8;
const EPISODE_ID = 'ctx-vec-episode';
const NOW = new Date('2026-08-28T12:00:00.000Z');

/**
 * A one-hot-shaped vector, but never a bare `0`/`1`: the vector index property is `FLOAT`-
 * typed, and a whole-number JS value risks the driver encoding it on the wire as a Cypher
 * `INTEGER` instead. Fractional components sidestep the question entirely.
 */
function unitVector(index: number): number[] {
  const vector = new Array<number>(EMBED_DIMENSION).fill(0.001);
  vector[index] = 0.995;
  return vector;
}

const EPISODE_VECTOR = unitVector(0);
const ENTITY_A_VECTOR = unitVector(1);
const ENTITY_B_VECTOR = unitVector(2);
const ENTITY_C_VECTOR = unitVector(3);

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let logger: Logger;

async function seedNeighborhood(driver: Driver): Promise<void> {
  await writeStampedNode(driver, {
    label: 'Episode',
    id: EPISODE_ID,
    now: NOW,
    occurredAt: NOW,
    properties: {
      text: 'user: ping\nassistant: pong',
      session_id: 'ctx-vec-session',
      content_vec: EPISODE_VECTOR,
    },
  });
  await writeStampedNode(driver, {
    label: 'Entity',
    id: 'entity-a',
    now: NOW,
    occurredAt: NOW,
    properties: {
      name: 'Alice',
      name_norm: 'alice',
      type: 'person',
      text: 'Alice',
      content_vec: ENTITY_A_VECTOR,
    },
  });
  await writeStampedNode(driver, {
    label: 'Entity',
    id: 'entity-b',
    now: NOW,
    occurredAt: NOW,
    properties: {
      name: 'Bob',
      name_norm: 'bob',
      type: 'person',
      text: 'Bob',
      content_vec: ENTITY_B_VECTOR,
    },
  });
  // Not mentioned by the episode: reachable only from entity-a, and only entity-a's own
  // recompute (a future run) should ever pick it up.
  await writeStampedNode(driver, {
    label: 'Entity',
    id: 'entity-c',
    now: NOW,
    occurredAt: NOW,
    properties: {
      name: 'Carol',
      name_norm: 'carol',
      type: 'person',
      text: 'Carol',
      content_vec: ENTITY_C_VECTOR,
    },
  });

  for (const entityId of ['entity-a', 'entity-b']) {
    await upsertEdge(driver, {
      type: 'PARTICIPATES_IN',
      sourceId: entityId,
      targetId: EPISODE_ID,
      strength: 1,
      confidence: 1,
      signals: ['structural'],
      provenance: ['test-fixture'],
      count: 0,
      now: NOW,
    });
    await upsertEdge(driver, {
      type: 'MENTIONS',
      sourceId: EPISODE_ID,
      targetId: entityId,
      strength: 1,
      confidence: 0.9,
      signals: ['episodic'],
      provenance: ['test-fixture'],
      count: 1,
      now: NOW,
    });
  }
  await upsertEdge(driver, {
    type: 'SIMILAR',
    sourceId: 'entity-a',
    targetId: 'entity-c',
    strength: 0.5,
    confidence: 0.7,
    signals: ['semantic'],
    provenance: ['test-fixture'],
    count: 1,
    now: NOW,
  });
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-context-vector-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });
  await seedNeighborhood(harness.driver);
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function buildContext(): StageContext {
  return {
    driver: harness.driver,
    db,
    provider: undefined as unknown as Provider,
    episodeId: EPISODE_ID,
    episode: {
      id: EPISODE_ID,
      sessionId: 'ctx-vec-session',
      text: 'user: ping\nassistant: pong',
      occurredAt: NOW,
      turns: [],
    },
    logger,
    now: NOW,
    occurredAt: NOW,
    pipelineVersion: PIPELINE_VERSION,
  };
}

describe('ContextVectorStage against a live graph', () => {
  it('recomputes context_vec for the episode and its mentioned entities, and skips the rest of the graph', async () => {
    const outcome = await new ContextVectorStage().run(buildContext());

    expect(outcome.status).toBe('ok');
    expect(outcome.counts).toEqual({ contextVectors: 3 });

    // entity-b's only neighbor category is the episode: the weighted mean of one distinct
    // vector is that vector, exactly.
    const entityB = await contextVector(harness.driver, 'entity-b');
    expect(entityB).toHaveLength(EMBED_DIMENSION);
    expect(entityB).toEqual(EPISODE_VECTOR);

    // The episode's neighbors are entity-a and entity-b in equal total weight (two edges
    // each): the mean sits at the componentwise midpoint of their two vectors.
    const episode = await contextVector(harness.driver, EPISODE_ID);
    for (let i = 0; i < EMBED_DIMENSION; i += 1) {
      expect(episode?.[i]).toBeCloseTo((ENTITY_A_VECTOR[i]! + ENTITY_B_VECTOR[i]!) / 2, 5);
    }

    // entity-c was never touched by this episode, so this run must not recompute it.
    const entityC = await contextVector(harness.driver, 'entity-c');
    expect(entityC).toBeUndefined();
  });

  it('makes the recomputed node findable by KNN over context_vec_idx', async () => {
    const rows = await vectorIndexNeighbors(harness.driver, 'context_vec_idx', 3, EPISODE_VECTOR);

    // entity-b's context_vec equals the episode's own content_vec exactly: a query with that
    // same vector should return entity-b as its top (or tied-top) hit.
    expect(rows.some((row) => row.id === 'entity-b')).toBe(true);
    const top = rows.reduce((best, row) => (row.score > best.score ? row : best));
    expect(top.id).toBe('entity-b');
  });
});
