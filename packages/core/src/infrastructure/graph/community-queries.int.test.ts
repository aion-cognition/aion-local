import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { writeStampedNode } from './bitemporal.js';
import { COMMUNITY_PROPERTY, readCommunityProfiles } from './community-queries.js';
import { runWrite } from './connection.js';
import { upsertEdge } from './edges.js';
import { runGraphMigrations } from './migrations.js';
import { STRUCTURAL_PROPERTY } from './seed-queries.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from './test-support/neo4j-harness.fixture.js';
import { toGraphDateTime } from './values.js';
import { openSqliteHandle, type SqliteHandle } from '../sqlite/database.js';

/**
 * The population a community profile scores against. Coherence and isolation are read off
 * these two counts, and the pair-edge read they are compared with filters closed and
 * structural endpoints, so this one has to filter the same population.
 */

const EMBED_DIMENSION = 4;

const OCCURRED_AT = new Date('2026-08-01T00:00:00.000Z');
const NOW = new Date('2026-08-02T00:00:00.000Z');
const CLOSED_AT = new Date('2026-08-03T00:00:00.000Z');

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;

async function seedMember(
  id: string,
  community: number,
  options: { readonly structural?: boolean } = {},
): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Insight',
    id,
    now: NOW,
    occurredAt: OCCURRED_AT,
    properties: {
      text: id,
      [COMMUNITY_PROPERTY]: community,
      [STRUCTURAL_PROPERTY]: options.structural === true,
    },
  });
}

async function seedEdge(sourceId: string, targetId: string): Promise<void> {
  await upsertEdge(harness.driver, {
    type: 'CO_OCCURS',
    sourceId,
    targetId,
    strength: 0.5,
    confidence: 0.5,
    signals: ['test'],
    provenance: ['test'],
    count: 1,
    now: NOW,
  });
}

async function closeNode(id: string): Promise<void> {
  await runWrite(
    harness.driver,
    'MATCH (n:AionNode { id: $id }) SET n.valid_until = $at RETURN n.id AS id',
    { id, at: toGraphDateTime(CLOSED_AT) },
    (row) => row.id as string,
  );
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-community-profile-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  await seedMember('mem-a', 1);
  await seedMember('mem-b', 1);
  await seedEdge('mem-a', 'mem-b');

  // Three neighbours in the other community: one live, one closed, one structural. Only the
  // live one is an external edge the pair read would also count.
  await seedMember('other-live', 2);
  await seedEdge('mem-b', 'other-live');
  await seedMember('other-closed', 2);
  await seedEdge('mem-a', 'other-closed');
  await closeNode('other-closed');
  await seedMember('other-structural', 2, { structural: true });
  await seedEdge('mem-b', 'other-structural');
}, 300_000);

afterAll(async () => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
  await stopNeo4jHarness(harness);
});

describe('the community profile read', () => {
  it('counts only edges to a live, non-structural neighbour', async () => {
    const profiles = await readCommunityProfiles(harness.driver, 2);

    expect(profiles).toEqual([{ community: 1, size: 2, externalEdges: 1, internalEdges: 1 }]);
  });
});
