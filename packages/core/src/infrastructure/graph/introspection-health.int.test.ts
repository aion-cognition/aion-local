import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BITEMPORAL_PROPERTIES, writeStampedNode } from './bitemporal.js';
import { runWrite } from './connection.js';
import { upsertEdge } from './edges.js';
import { countOrphanNodes } from './introspection-health.js';
import { runGraphMigrations } from './migrations.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from './test-support/neo4j-harness.fixture.js';
import { toGraphDateTime } from './values.js';
import { openSqliteHandle, type SqliteHandle } from '../sqlite/database.js';

/**
 * The orphan count against a real server. It turns on a bitemporal predicate over a
 * relationship, which no fake graph carries.
 */

const EMBED_DIMENSION = 8;
const NOW = new Date('2026-09-01T09:00:00.000Z');
const PRUNED_AT = new Date('2026-09-01T10:00:00.000Z');

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-introspection-health-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  for (const id of ['orphan-health-a', 'orphan-health-b']) {
    await writeStampedNode(harness.driver, {
      label: 'Concept',
      id,
      now: NOW,
      properties: { text: `concept ${id}` },
    });
  }
  await upsertEdge(harness.driver, {
    type: 'RELATED_TO',
    sourceId: 'orphan-health-a',
    targetId: 'orphan-health-b',
    strength: 0.5,
    confidence: 0.5,
    signals: ['test'],
    provenance: ['test'],
    now: NOW,
  });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('the orphan count over a pruned association', () => {
  it('counts a node whose only association edge was closed as an orphan', async () => {
    const connected = await countOrphanNodes(harness.driver);
    expect(connected).toEqual({ nodes: 2, orphans: 0 });

    // What `edge_prune` writes: the edge stays and closes in world time.
    await runWrite(
      harness.driver,
      [
        'MATCH ()-[r:RELATED_TO]-()',
        `SET r.${BITEMPORAL_PROPERTIES.validUntil} = $now`,
        'RETURN count(r) AS closed',
      ].join('\n'),
      { now: toGraphDateTime(PRUNED_AT) },
      (row) => row.closed as number,
    );

    expect(await countOrphanNodes(harness.driver)).toEqual({ nodes: 2, orphans: 2 });
  }, 120_000);
});
