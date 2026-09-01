import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { writeStampedNode } from './bitemporal.js';
import { upsertEdge } from './edges.js';
import { redirectAndAbsorb } from './entity-merge-queries.js';
import { runGraphMigrations } from './migrations.js';
import {
  countEdges,
  nodeProperties,
  supersedingNodeIds,
} from './test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from './test-support/neo4j-harness.fixture.js';
import { openSqliteHandle, type SqliteHandle } from '../sqlite/database.js';

/**
 * The merge write path against a real server. Each case here is a claim about what
 * `redirectAndAbsorb` does inside its own transaction under a live lock manager, where a
 * concurrent writer can take a member's currency between the decision and the write. The
 * fake graph cannot lose these races, so it cannot prove any of this.
 */

const EMBED_DIMENSION = 8;
const NOW = new Date('2026-09-01T00:00:00.000Z');
const LATER = new Date('2026-09-01T00:05:00.000Z');

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;

async function seedEntity(id: string): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Entity',
    id,
    properties: { name: id, name_norm: id, type: 'concept' },
    now: NOW,
  });
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-entity-merge-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('a merge deciding from a stale snapshot', () => {
  it('refuses the whole group when another merge already absorbed a member', async () => {
    for (const id of ['stale-canon', 'stale-dup', 'stale-rival', 'stale-neighbor']) {
      await seedEntity(id);
    }
    await upsertEdge(harness.driver, {
      type: 'CO_OCCURS',
      sourceId: 'stale-dup',
      targetId: 'stale-neighbor',
      strength: 0.5,
      confidence: 1,
      signals: ['episodic'],
      provenance: ['test'],
      count: 1,
      now: NOW,
    });

    // The rival lands first: stale-dup loses currency to stale-rival.
    await redirectAndAbsorb(harness.driver, {
      canonicalId: 'stale-rival',
      canonicalNameNorm: 'stale-rival',
      mergedIds: ['stale-dup'],
      aliases: ['stale-dup'],
      accessCount: 0,
      now: NOW,
    });

    // This merge decided on a snapshot taken before the rival committed.
    const result = await redirectAndAbsorb(harness.driver, {
      canonicalId: 'stale-canon',
      canonicalNameNorm: 'stale-canon',
      mergedIds: ['stale-dup'],
      aliases: ['stale-dup'],
      accessCount: 3,
      now: LATER,
    });

    // Nothing of the stale group's write lands: no redirected edge, no provenance record,
    // and the absorbed identity answers to its real canonical alone.
    expect(await countEdges(harness.driver, 'CO_OCCURS', 'stale-canon', 'stale-neighbor')).toBe(0);
    const props = await nodeProperties(harness.driver, 'stale-canon');
    expect(props.merge_provenance ?? []).toEqual([]);
    expect(await supersedingNodeIds(harness.driver, 'stale-dup')).toEqual(['stale-rival']);
    expect(result.status).toBe('stale');
  });
});
