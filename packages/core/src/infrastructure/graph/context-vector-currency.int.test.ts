import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { writeStampedNode } from './bitemporal.js';
import { runWrite } from './connection.js';
import { findNeighborContentVectors } from './context-vector-queries.js';
import { findStaleContextVectorNodes, markContextVectorSynced } from './context-vector-sync.js';
import { upsertEdge } from './edges.js';
import { runGraphMigrations } from './migrations.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from './test-support/neo4j-harness.fixture.js';
import { toGraphDateTime } from './values.js';
import { openSqliteHandle, type SqliteHandle } from '../sqlite/database.js';

/**
 * What a stored context vector counts as drift, and which edges feed one. Decay and the prune
 * close move stamps no reinforcement writes, and both change the neighborhood a stored vector
 * was taken over.
 */

const EMBED_DIMENSION = 4;

const OCCURRED_AT = new Date('2026-08-01T00:00:00.000Z');
/** Before every sync stamp below, so an edge written at this clock is old by itself. */
const EDGE_WRITTEN_AT = new Date('2026-08-02T00:00:00.000Z');
const SYNCED_AT = new Date('2026-08-03T00:00:00.000Z');
/** After the sync stamp: the moment a sweep touched the edge. */
const SWEPT_AT = new Date('2026-08-04T00:00:00.000Z');

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;

function vector(seed: number): number[] {
  return Array.from({ length: EMBED_DIMENSION }, (_, index) => seed + index / 10);
}

async function seedNode(id: string, seed: number, syncedAt?: Date): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Episode',
    id,
    now: EDGE_WRITTEN_AT,
    occurredAt: OCCURRED_AT,
    properties: { text: id, content_vec: vector(seed) },
    ...(syncedAt === undefined ? {} : { mergeProperties: { context_vec_synced_at: syncedAt } }),
  });
}

async function seedEdge(sourceId: string, targetId: string): Promise<void> {
  await upsertEdge(harness.driver, {
    type: 'CO_OCCURS',
    sourceId,
    targetId,
    strength: 0.6,
    confidence: 0.6,
    signals: ['test'],
    provenance: ['test'],
    count: 1,
    now: EDGE_WRITTEN_AT,
  });
}

async function stampEdge(sourceId: string, targetId: string, property: string): Promise<void> {
  await runWrite(
    harness.driver,
    [
      // Undirected: the upsert stores an undirected type on the id-sorted endpoint pair.
      'MATCH (a:AionNode { id: $sourceId })-[r:CO_OCCURS]-(b:AionNode { id: $targetId })',
      `SET r.${property} = $stamp`,
      'RETURN r.id AS id',
    ].join('\n'),
    { sourceId, targetId, stamp: toGraphDateTime(SWEPT_AT) },
    (row) => row.id as string,
  );
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-context-vector-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  // Three synced nodes, one per way an edge can move: decay, a prune close, and nothing.
  await seedNode('decayed-node', 1, SYNCED_AT);
  await seedNode('decayed-peer', 2);
  await seedEdge('decayed-node', 'decayed-peer');
  await stampEdge('decayed-node', 'decayed-peer', 'decayed_at');

  await seedNode('pruned-node', 3, SYNCED_AT);
  await seedNode('pruned-peer', 4);
  await seedEdge('pruned-node', 'pruned-peer');
  await stampEdge('pruned-node', 'pruned-peer', 'valid_until');

  await seedNode('quiet-node', 5, SYNCED_AT);
  await seedNode('quiet-peer', 6);
  await seedEdge('quiet-node', 'quiet-peer');

  // One node holding both an open and a closed edge, for the neighborhood read.
  await seedNode('mixed-node', 7, SYNCED_AT);
  await seedNode('open-peer', 8);
  await seedNode('closed-peer', 9);
  await seedEdge('mixed-node', 'open-peer');
  await seedEdge('mixed-node', 'closed-peer');
  await stampEdge('mixed-node', 'closed-peer', 'valid_until');
}, 300_000);

afterAll(async () => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
  await stopNeo4jHarness(harness);
});

describe('the stale context vector scan', () => {
  it('selects a node whose only movement was the decay sweep', async () => {
    const stale = await findStaleContextVectorNodes(harness.driver, 50);

    expect(stale).toContain('decayed-node');
  });

  it('selects a node whose neighbor edge the prune closed', async () => {
    const stale = await findStaleContextVectorNodes(harness.driver, 50);

    expect(stale).toContain('pruned-node');
  });

  it('leaves a node whose neighborhood has not moved since its sync', async () => {
    const stale = await findStaleContextVectorNodes(harness.driver, 50);

    expect(stale).not.toContain('quiet-node');
  });
});

describe('the neighborhood a context vector is computed from', () => {
  it('drops the neighbor across a closed edge', async () => {
    const rows = await findNeighborContentVectors(harness.driver, ['mixed-node']);

    expect(rows.map((row) => row.neighborId)).toEqual(['open-peer']);
  });
});

describe('a stale node the pass computed nothing for', () => {
  it('leaves the scan once it is marked examined', async () => {
    expect(await findStaleContextVectorNodes(harness.driver, 50)).toContain('quiet-peer');

    await markContextVectorSynced(harness.driver, ['quiet-peer'], SWEPT_AT);

    expect(await findStaleContextVectorNodes(harness.driver, 50)).not.toContain('quiet-peer');
  });
});
