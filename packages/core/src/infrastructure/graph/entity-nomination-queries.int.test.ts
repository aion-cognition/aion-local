import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { writeStampedNode } from './bitemporal.js';
import { readFirst } from './connection.js';
import { upsertEdge } from './edges.js';
import { ENTITY_MENTION_TYPE } from './entity-mention-queries.js';
import {
  ENTITY_MENTION_PROJECTION_NAME,
  nodeSimilarityAvailable,
  nominateSharedEpisodePairs,
} from './entity-nomination-queries.js';
import { runGraphMigrations } from './migrations.js';
import { STRUCTURAL_PROPERTY } from './seed-queries.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from './test-support/neo4j-harness.fixture.js';
import { openSqliteHandle, type SqliteHandle } from '../sqlite/database.js';

/**
 * Bulk nomination through GDS, against a real server with the plugin loaded. The projection
 * discipline is the point as much as the numbers: one static name, reclaimed before use and
 * dropped after it whatever happens, and not one edge written by a nominator.
 */

const EMBED_DIMENSION = 768;
const NOW = new Date('2026-09-01T00:00:00.000Z');

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;

async function entity(id: string, structural = false): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Entity',
    id,
    now: NOW,
    properties: { name: id, name_norm: id, type: 'tool', [STRUCTURAL_PROPERTY]: structural },
  });
}

async function mentions(episodeId: string, entityId: string): Promise<void> {
  await upsertEdge(harness.driver, {
    type: ENTITY_MENTION_TYPE,
    sourceId: episodeId,
    targetId: entityId,
    strength: 1,
    confidence: 1,
    signals: ['episodic'],
    provenance: ['test'],
    count: 1,
    now: NOW,
  });
}

async function relationshipCount(): Promise<number> {
  return (
    (await readFirst(
      harness.driver,
      'MATCH ()-[r]->() RETURN count(r) AS count',
      {},
      (row) => row.count as number,
    )) ?? 0
  );
}

async function projectionExists(): Promise<boolean> {
  return (
    (await readFirst(
      harness.driver,
      'CALL gds.graph.exists($name) YIELD exists RETURN exists',
      { name: ENTITY_MENTION_PROJECTION_NAME },
      (row) => row.exists === true,
    )) ?? false
  );
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-entity-nomination-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  for (const id of ['alpha', 'beta', 'gamma']) {
    await entity(id);
  }
  await entity('backbone-member', true);
  for (const id of ['ep-1', 'ep-2', 'ep-3', 'ep-4', 'ep-5']) {
    await writeStampedNode(harness.driver, {
      label: 'Episode',
      id,
      now: NOW,
      properties: { text: id },
    });
  }
  // alpha and beta share ep-2 and ep-3 out of a union of four: Jaccard 0.5. gamma shares
  // nothing with either, and the structural node shares ep-1 with alpha so that its exclusion
  // is a fact about the projection rather than about having no edges.
  await mentions('ep-1', 'alpha');
  await mentions('ep-2', 'alpha');
  await mentions('ep-3', 'alpha');
  await mentions('ep-2', 'beta');
  await mentions('ep-3', 'beta');
  await mentions('ep-4', 'beta');
  await mentions('ep-5', 'gamma');
  await mentions('ep-1', 'backbone-member');
}, 300_000);

afterAll(async () => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
  await stopNeo4jHarness(harness);
});

describe('shared-episode nomination', () => {
  it('finds the plugin the image ships', async () => {
    expect(await nodeSimilarityAvailable(harness.driver)).toBe(true);
  });

  it('nominates the pair by its shared-episode Jaccard, id-sorted and once', async () => {
    const result = await nominateSharedEpisodePairs(harness.driver, { jaccardFloor: 0.1 });

    expect(result.status).toBe('ok');
    expect(result.status === 'ok' ? result.nominations : []).toEqual([
      { leftId: 'alpha', rightId: 'beta', sharedEpisodeJaccard: 0.5 },
    ]);
  });

  it('drops a pair under the floor rather than handing the cascade every co-mention', async () => {
    const result = await nominateSharedEpisodePairs(harness.driver, { jaccardFloor: 0.6 });

    expect(result.status === 'ok' ? result.nominations : ['unavailable']).toEqual([]);
  });

  it('leaves a structural entity out of the projection', async () => {
    const result = await nominateSharedEpisodePairs(harness.driver, { jaccardFloor: 0 });
    const named = (result.status === 'ok' ? result.nominations : []).flatMap((pair) => [
      pair.leftId,
      pair.rightId,
    ]);

    expect(named).not.toContain('backbone-member');
  });

  it('writes no edge: nomination is input to the cascade, never a decision', async () => {
    const before = await relationshipCount();
    await nominateSharedEpisodePairs(harness.driver, { jaccardFloor: 0 });

    expect(await relationshipCount()).toBe(before);
  });

  it('leaves the catalog as it found it, under one name with no timestamp in it', async () => {
    expect(ENTITY_MENTION_PROJECTION_NAME).not.toMatch(/\d/);
    await nominateSharedEpisodePairs(harness.driver, { jaccardFloor: 0.1 });

    expect(await projectionExists()).toBe(false);
  });

  it('reclaims a projection a dead run left behind rather than failing on the taken name', async () => {
    await nominateSharedEpisodePairs(harness.driver, { jaccardFloor: 0.1 });
    // Stand in for the run that died between project and drop.
    await harness.driver.executeQuery(
      'CALL gds.graph.project.cypher($name, $nodeQuery, $relationshipQuery)',
      {
        name: ENTITY_MENTION_PROJECTION_NAME,
        nodeQuery: 'MATCH (n:Entity) RETURN id(n) AS id',
        relationshipQuery:
          'MATCH (a:Entity)-[r]->(b:Entity) RETURN id(a) AS source, id(b) AS target',
      },
    );

    const result = await nominateSharedEpisodePairs(harness.driver, { jaccardFloor: 0.1 });

    expect(result.status === 'ok' ? result.nominations : []).toEqual([
      { leftId: 'alpha', rightId: 'beta', sharedEpisodeJaccard: 0.5 },
    ]);
    expect(await projectionExists()).toBe(false);
  });
});
