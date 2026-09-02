import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { fetchAdjacency } from './adjacency.js';
import { writeStampedNode } from './bitemporal.js';
import { upsertEdge } from './edges.js';
import { MEMORY_PROPERTIES } from './episodes.js';
import { runGraphMigrations } from './migrations.js';
import { fetchNodeProvenance } from './node-provenance.js';
import { VALID_HORIZON_PROPERTY, type Currency } from './read-modes.js';
import { fulltextSeeds, lucenePhraseQuery } from './seed-queries.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from './test-support/neo4j-harness.fixture.js';
import { readModeFor } from '../../recall/application/read-mode.js';
import { openSqliteHandle, type SqliteHandle } from '../sqlite/database.js';

/**
 * One recall issues a dozen fragments, and each of them used to read the wall clock for
 * itself. A reading whose horizon falls inside a single call then came back current on the
 * leg that ran first and expired on the leg that ran a millisecond later, with fusion picking
 * the survivor by relevance rather than by currency.
 *
 * Three genuinely different fragments are driven here, against a real database: the seed
 * statement's own node variable, the adjacency statement's namespaced neighbour, and the
 * provenance read. They agree because the mode carries the run's clock, not because they run
 * close together.
 */

const EMBED_DIMENSION = 8;

const OCCURRED_AT = new Date('2026-06-01T09:00:00.000Z');

/** The horizon the reading was written with, and the instant the run's clock is pinned around. */
const HORIZON = new Date('2026-07-01T09:00:00.000Z');

const READING_ID = 'reading-queue-depth';
const NEIGHBOUR_ID = 'episode-queue-depth';
const READING_TEXT = 'the Quillon ingest queue holds 4.2 million rows';

const QUERY = { query: 'quillon ingest queue' };

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;

/** Every leg's answer for the one reading, in the order recall would ask them. */
async function currencyOnEveryLeg(now: Date): Promise<readonly (Currency | undefined)[]> {
  const mode = readModeFor(QUERY, { now, expiryAnnotation: true });

  const seeds = await fulltextSeeds(harness.driver, {
    query: lucenePhraseQuery(READING_TEXT),
    limit: 10,
    mode,
  });
  const neighbours = await fetchAdjacency(harness.driver, {
    frontier: [NEIGHBOUR_ID],
    visited: [],
    mode,
    minStrength: 0,
    topK: 10,
  });
  const provenance = await fetchNodeProvenance(harness.driver, READING_ID, mode);

  return [
    seeds.find((seed) => seed.id === READING_ID)?.currency,
    neighbours.find((neighbour) => neighbour.nodeId === READING_ID)?.currency.currency,
    provenance?.currency,
  ];
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-read-modes-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  await writeStampedNode(harness.driver, {
    label: 'Episode',
    id: NEIGHBOUR_ID,
    now: OCCURRED_AT,
    occurredAt: OCCURRED_AT,
    properties: { [MEMORY_PROPERTIES.text]: 'the queue depth review' },
  });
  await writeStampedNode(harness.driver, {
    label: 'Concept',
    id: READING_ID,
    now: OCCURRED_AT,
    occurredAt: OCCURRED_AT,
    properties: { [MEMORY_PROPERTIES.text]: READING_TEXT, [VALID_HORIZON_PROPERTY]: HORIZON },
  });
  await upsertEdge(harness.driver, {
    type: 'EXTRACTED_FROM',
    sourceId: READING_ID,
    targetId: NEIGHBOUR_ID,
    strength: 1,
    confidence: 1,
    signals: ['fixture'],
    provenance: ['fixture'],
    now: OCCURRED_AT,
  });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('one recall, many fragments, one clock', () => {
  it('reports a reading short of its horizon as current on every leg', async () => {
    const before = new Date(HORIZON.getTime() - 1);

    expect(await currencyOnEveryLeg(before)).toEqual(['current', 'current', 'current']);
  });

  it('reports the same reading expired on every leg once the clock reaches its horizon', async () => {
    expect(await currencyOnEveryLeg(HORIZON)).toEqual(['expired', 'expired', 'expired']);
  });

  it('reports it expired on every leg past the horizon, and still returns it', async () => {
    const after = new Date(HORIZON.getTime() + 24 * 60 * 60 * 1000);

    expect(await currencyOnEveryLeg(after)).toEqual(['expired', 'expired', 'expired']);
  });

  /** Expiry annotates; it never moves a predicate, so the row set is the row set either way. */
  it('keeps the expired reading in the row set every leg returns', async () => {
    const mode = readModeFor(QUERY, { now: HORIZON, expiryAnnotation: true });

    const seeds = await fulltextSeeds(harness.driver, {
      query: lucenePhraseQuery(READING_TEXT),
      limit: 10,
      mode,
    });

    expect(seeds.map((seed) => seed.id)).toContain(READING_ID);
  });

  it('reports it current on every leg with the expiry annotation switched off', async () => {
    const mode = readModeFor(QUERY, { now: HORIZON, expiryAnnotation: false });

    const provenance = await fetchNodeProvenance(harness.driver, READING_ID, mode);

    expect(provenance?.currency).toBe('current');
  });
});
