import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { writeStampedNode } from './bitemporal.js';
import { readClaimCommunityProfiles } from './claim-consolidation-queries.js';
import { COMMUNITY_PROPERTY } from './community-queries.js';
import { upsertEdge } from './edges.js';
import { CONTAINMENT_TYPE } from './episodes.js';
import { EXTRACTION_TYPE } from './labels.js';
import { runGraphMigrations } from './migrations.js';
import type { RelationshipType } from './relationships.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from './test-support/neo4j-harness.fixture.js';
import { openSqliteHandle, type SqliteHandle } from '../sqlite/database.js';

/**
 * The density floor is derived from the sizes this profile read reports, so a community it
 * drops moves the floor for every other one. A consolidated claim carries no `EXTRACTED_FROM`
 * edge, which is the case that has no session path at all.
 */

const EMBED_DIMENSION = 4;

const OCCURRED_AT = new Date('2026-08-01T00:00:00.000Z');
const NOW = new Date('2026-08-02T00:00:00.000Z');

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;

async function seedClaim(id: string, community: number): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Decision',
    id,
    now: NOW,
    occurredAt: OCCURRED_AT,
    properties: { text: id, [COMMUNITY_PROPERTY]: community },
  });
}

async function link(type: RelationshipType, sourceId: string, targetId: string): Promise<void> {
  await upsertEdge(harness.driver, {
    type,
    sourceId,
    targetId,
    strength: 1,
    confidence: 1,
    signals: ['test'],
    provenance: ['test'],
    count: 1,
    now: NOW,
  });
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-claim-consolidation-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  await writeStampedNode(harness.driver, {
    label: 'Session',
    id: 'session-1',
    now: NOW,
    properties: { name: 'session-1' },
  });
  await writeStampedNode(harness.driver, {
    label: 'Episode',
    id: 'episode-1',
    now: NOW,
    occurredAt: OCCURRED_AT,
    properties: { text: 'episode-1', session_id: 'session-1' },
  });
  await link(CONTAINMENT_TYPE, 'episode-1', 'session-1');

  // Community 1 came out of a real episode; community 2 is a consolidation, which is written
  // with no provenance edge and so reaches no session.
  await seedClaim('claim-sourced', 1);
  await link(EXTRACTION_TYPE, 'claim-sourced', 'episode-1');
  await seedClaim('claim-consolidated', 2);
}, 300_000);

afterAll(async () => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
  await stopNeo4jHarness(harness);
});

describe('the claim community profile read', () => {
  it('reports a community whose claims reach no session', async () => {
    const profiles = await readClaimCommunityProfiles(harness.driver);

    expect(profiles).toEqual([
      { community: 1, size: 1, sessions: 1 },
      { community: 2, size: 1, sessions: 0 },
    ]);
  });
});
