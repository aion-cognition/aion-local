import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { fetchAdjacency } from './adjacency.js';
import { writeStampedNode } from './bitemporal.js';
import { upsertEdge } from './edges.js';
import { MEMORY_PROPERTIES } from './episodes.js';
import { runGraphMigrations } from './migrations.js';
import { SUMMARIZED_BY_TYPE } from './narrative-queries.js';
import { asOf, knewAt, withCurrency } from './read-modes.js';
import { closeEdge } from './test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from './test-support/neo4j-harness.fixture.js';
import { openSqliteHandle, type SqliteHandle } from '../sqlite/database.js';

/**
 * The two halves of mode-aware edge visibility, against a real server: a closed relationship is
 * gone from the present and still there in the past. A statement-shape test cannot say whether
 * the predicate the builder emits is one the planner accepts, and the degree subquery is the
 * part most likely to be rejected rather than merely wrong.
 */

const EMBED_DIMENSION = 8;

const EPISODE_ID = 'adjacency-episode';
const STANDING_ID = 'adjacency-narrative-standing';
const CLOSED_ID = 'adjacency-narrative-closed';

const OCCURRED_AT = new Date('2026-06-01T09:00:00.000Z');
/** When the older narrative stopped standing, and with it the edge summarizing into it. */
const CLOSED_AT = new Date('2026-06-02T09:00:00.000Z');
const BEFORE_THE_CLOSE = new Date('2026-06-01T18:00:00.000Z');
const AFTER_THE_CLOSE = new Date('2026-06-03T09:00:00.000Z');

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;

async function seedMemory(id: string): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Episode',
    id,
    now: OCCURRED_AT,
    occurredAt: OCCURRED_AT,
    properties: { [MEMORY_PROPERTIES.text]: `body of ${id}` },
  });
}

async function summarize(episodeId: string, narrativeId: string): Promise<void> {
  await upsertEdge(harness.driver, {
    type: SUMMARIZED_BY_TYPE,
    sourceId: episodeId,
    targetId: narrativeId,
    strength: 1,
    confidence: 1,
    signals: ['compression'],
    provenance: ['test-seed'],
    count: 0,
    now: OCCURRED_AT,
  });
}

async function neighboursAt(mode: Parameters<typeof fetchAdjacency>[1]['mode']): Promise<{
  ids: string[];
  degrees: Map<string, number>;
}> {
  const rows = await fetchAdjacency(harness.driver, {
    frontier: [EPISODE_ID],
    visited: [],
    mode,
    minStrength: 0,
    topK: 10,
  });
  return {
    ids: rows.map((row) => row.nodeId).sort(),
    degrees: new Map(rows.map((row) => [row.nodeId, row.degree])),
  };
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-adjacency-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  await seedMemory(EPISODE_ID);
  await seedMemory(STANDING_ID);
  await seedMemory(CLOSED_ID);
  await summarize(EPISODE_ID, STANDING_ID);
  await summarize(EPISODE_ID, CLOSED_ID);
  await closeEdge(harness.driver, SUMMARIZED_BY_TYPE, EPISODE_ID, CLOSED_ID, CLOSED_AT);
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('traversal over a closed relationship', () => {
  it('walks only the open edge in the present', async () => {
    const { ids } = await neighboursAt(withCurrency());

    expect(ids).toEqual([STANDING_ID]);
  });

  it('walks the closed edge again from a world time before it closed', async () => {
    const { ids } = await neighboursAt(asOf(BEFORE_THE_CLOSE));

    expect(ids).toEqual([CLOSED_ID, STANDING_ID].sort());
  });

  it('drops it again from a world time after it closed', async () => {
    const { ids } = await neighboursAt(asOf(AFTER_THE_CLOSE));

    expect(ids).toEqual([STANDING_ID]);
  });

  it('walks it from a knowledge time before the substrate closed it', async () => {
    const { ids } = await neighboursAt(knewAt(BEFORE_THE_CLOSE));

    expect(ids).toContain(CLOSED_ID);
  });
});

describe('the degree a neighbour is priced by', () => {
  it('counts the fan-out that is open now, not everything stored on the node', async () => {
    const { degrees } = await neighboursAt(withCurrency());

    // The one open summarization edge; the closed one is stored on the same episode.
    expect(degrees.get(STANDING_ID)).toBe(1);
  });

  it('counts the fan-out a historical read can still walk', async () => {
    const { degrees } = await neighboursAt(asOf(BEFORE_THE_CLOSE));

    expect(degrees.get(CLOSED_ID)).toBe(1);
    expect(degrees.get(STANDING_ID)).toBe(1);
  });
});
