import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { supersede, writeStampedNode } from '../../../infrastructure/graph/bitemporal.js';
import { TEXT_NORM_PROPERTY } from '../../../infrastructure/graph/cognitive-queries.js';
import { upsertEdge } from '../../../infrastructure/graph/edges.js';
import { MEMORY_PROPERTIES } from '../../../infrastructure/graph/episodes.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import { findEpisodeCognitiveNodes } from '../../../infrastructure/graph/semantic-relationship-queries.js';
import { findEpisodeFactNodes } from '../../../infrastructure/graph/supersession-queries.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';

/**
 * The two episode-scoped reads the semantic-relationship and supersession stages build their
 * candidate sets from. A default read mode annotates currency instead of filtering it, so what
 * only a real server proves is that each statement carries its own close predicate: an edge
 * must not be written onto a claim that no longer stands, and a claim that no longer stands
 * must not become the subject that closes a live one.
 */

const EMBED_DIMENSION = 8;
const NOW = new Date('2026-04-06T09:00:00.000Z');
const EPISODE_ID = 'currency-episode';
const STANDING_ID = 'currency-decision-standing';
const CLOSED_ID = 'currency-decision-closed';

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;

async function seedDecision(id: string, text: string): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Decision',
    id,
    now: NOW,
    occurredAt: NOW,
    properties: {
      [MEMORY_PROPERTIES.text]: text,
      [TEXT_NORM_PROPERTY]: text.toLowerCase(),
      [MEMORY_PROPERTIES.extractionMethod]: 'currency_fixture',
    },
  });
  await upsertEdge(harness.driver, {
    type: 'EXTRACTED_FROM',
    sourceId: id,
    targetId: EPISODE_ID,
    strength: 1,
    confidence: 1,
    signals: ['extraction'],
    provenance: ['currency_fixture'],
    count: 0,
    now: NOW,
  });
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-episode-currency-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  await writeStampedNode(harness.driver, {
    label: 'Episode',
    id: EPISODE_ID,
    now: NOW,
    occurredAt: NOW,
    properties: { [MEMORY_PROPERTIES.text]: 'the episode both claims were extracted from' },
  });
  await seedDecision(STANDING_ID, 'The queue runs on SQLite.');
  await seedDecision(CLOSED_ID, 'The queue runs inside the Postgres transaction.');
  await supersede(harness.driver, {
    oldId: CLOSED_ID,
    newId: STANDING_ID,
    now: NOW,
    validUntil: NOW,
    signals: ['contradiction'],
    provenance: ['currency_fixture'],
  });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('the episode reads that build a stage candidate set', () => {
  it('offers the semantic-relationship stage no cognitive node that has been closed', async () => {
    const nodes = await findEpisodeCognitiveNodes(harness.driver, EPISODE_ID, NOW);

    expect(nodes.map((node) => node.id)).toEqual([STANDING_ID]);
  });

  it('offers the supersession stage no fact node that has been closed', async () => {
    const nodes = await findEpisodeFactNodes(harness.driver, EPISODE_ID, NOW);

    expect(nodes.map((node) => node.id)).toEqual([STANDING_ID]);
  });
});
