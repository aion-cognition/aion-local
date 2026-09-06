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
import { asOf, bitemporalAt, knewAt, withCurrency } from './read-modes.js';
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

/** The pair for the recording-time floor: written after the moment a later read pins. */
const LATE_EPISODE_ID = 'adjacency-late-episode';
const LATE_NARRATIVE_ID = 'adjacency-late-narrative';

const OCCURRED_AT = new Date('2026-06-01T09:00:00.000Z');
/** When the older narrative stopped standing, and with it the edge summarizing into it. */
const CLOSED_AT = new Date('2026-06-02T09:00:00.000Z');
const BEFORE_THE_CLOSE = new Date('2026-06-01T18:00:00.000Z');
const AFTER_THE_CLOSE = new Date('2026-06-03T09:00:00.000Z');

/** The late edge is recorded on the 3rd and closed on the 4th; nothing knew it on the 2nd. */
const RECORDED_AT = new Date('2026-06-03T09:00:00.000Z');
const LATE_CLOSED_AT = new Date('2026-06-04T09:00:00.000Z');
const BEFORE_IT_WAS_RECORDED = new Date('2026-06-02T09:00:00.000Z');

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;

async function seedMemory(id: string, at: Date = OCCURRED_AT): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Episode',
    id,
    now: at,
    occurredAt: at,
    properties: { [MEMORY_PROPERTIES.text]: `body of ${id}` },
  });
}

async function summarize(
  episodeId: string,
  narrativeId: string,
  at: Date = OCCURRED_AT,
): Promise<void> {
  await upsertEdge(harness.driver, {
    type: SUMMARIZED_BY_TYPE,
    sourceId: episodeId,
    targetId: narrativeId,
    strength: 1,
    confidence: 1,
    signals: ['compression'],
    provenance: ['test-seed'],
    count: 0,
    now: at,
  });
}

async function neighboursOf(
  frontierId: string,
  mode: Parameters<typeof fetchAdjacency>[1]['mode'],
): Promise<{
  ids: string[];
  degrees: Map<string, number>;
  activeDegrees: Map<string, number | undefined>;
}> {
  const rows = await fetchAdjacency(harness.driver, {
    frontier: [frontierId],
    visited: [],
    mode,
    minStrength: 0,
    topK: 10,
    measureActiveDegree: true,
  });
  return {
    ids: rows.map((row) => row.nodeId).sort(),
    degrees: new Map(rows.map((row) => [row.nodeId, row.degree])),
    activeDegrees: new Map(rows.map((row) => [row.nodeId, row.activeDegree])),
  };
}

async function neighboursAt(
  mode: Parameters<typeof fetchAdjacency>[1]['mode'],
): ReturnType<typeof neighboursOf> {
  return neighboursOf(EPISODE_ID, mode);
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

  // Both nodes are known from the start, so every read below turns on the edge alone: a node
  // written later would be filtered by the read mode's own node predicate and the edge
  // predicate under test would never be reached.
  await seedMemory(LATE_EPISODE_ID);
  await seedMemory(LATE_NARRATIVE_ID);
  await summarize(LATE_EPISODE_ID, LATE_NARRATIVE_ID, RECORDED_AT);
  await closeEdge(
    harness.driver,
    SUMMARIZED_BY_TYPE,
    LATE_EPISODE_ID,
    LATE_NARRATIVE_ID,
    LATE_CLOSED_AT,
  );
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

/**
 * The other half of a knowledge-time read. Closing an edge is not the only thing that puts it
 * outside a pinned moment: an edge the substrate had not recorded yet was not known then
 * either, and a read that tests only the close admits a relationship out of its own future.
 */
describe('traversal from before the substrate recorded the edge', () => {
  it('refuses an edge recorded after the knowledge time being read', async () => {
    const { ids } = await neighboursOf(LATE_EPISODE_ID, knewAt(BEFORE_IT_WAS_RECORDED));

    expect(ids).toEqual([]);
  });

  it('walks the same edge from a knowledge time after it was recorded', async () => {
    const { ids } = await neighboursOf(LATE_EPISODE_ID, knewAt(RECORDED_AT));

    expect(ids).toEqual([LATE_NARRATIVE_ID]);
  });

  it('refuses it under a bitemporal read pinned before the recording as well', async () => {
    // World time sits before the close, so that arm admits the edge and the knowledge floor is
    // the only thing that can refuse it. Pinning world time after the close instead would pass
    // for the wrong reason.
    const { ids } = await neighboursOf(
      LATE_EPISODE_ID,
      bitemporalAt(RECORDED_AT, BEFORE_IT_WAS_RECORDED),
    );

    expect(ids).toEqual([]);
  });

  it('leaves the recording floor off a world-time read, which asks a different question', async () => {
    const { ids } = await neighboursOf(LATE_EPISODE_ID, asOf(BEFORE_IT_WAS_RECORDED));

    expect(ids).toEqual([LATE_NARRATIVE_ID]);
  });
});

describe('the degree a neighbour is priced by', () => {
  it('counts every relationship stored on the node, closed ones included', async () => {
    const { degrees } = await neighboursAt(withCurrency());

    // Both summarization edges are stored on the episode, and only one is open. Scoring reads
    // the stored number: closing an edge must not quietly change how a hub is inhibited.
    expect(degrees.get(STANDING_ID)).toBe(1);
    expect(degrees.get(CLOSED_ID)).toBeUndefined();
  });

  it('reports active fan-out beside it, smaller than the stored degree', async () => {
    const { degrees, activeDegrees } = await neighboursOf(STANDING_ID, withCurrency());

    // Read from the episode's side: it stores two summarization edges and can walk one.
    expect(degrees.get(EPISODE_ID)).toBe(2);
    expect(activeDegrees.get(EPISODE_ID)).toBe(1);
  });

  it('measures the fan-out a historical read can still walk', async () => {
    const { activeDegrees } = await neighboursOf(STANDING_ID, asOf(BEFORE_THE_CLOSE));

    expect(activeDegrees.get(EPISODE_ID)).toBe(2);
  });
});
