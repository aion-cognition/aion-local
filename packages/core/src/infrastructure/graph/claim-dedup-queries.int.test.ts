import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { writeStampedNode } from './bitemporal.js';
import { mergeClaimPair } from './claim-dedup-queries.js';
import { runWrite } from './connection.js';
import { runGraphMigrations } from './migrations.js';
import { supersedingNodeIds } from './test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from './test-support/neo4j-harness.fixture.js';
import { toGraphDateTime } from './values.js';
import { openSqliteHandle, type SqliteHandle } from '../sqlite/database.js';

/**
 * A claim merge is judged against a currency reading taken before two model calls. The write
 * has to read currency again inside its own transaction: a pair whose loser another writer
 * closed in between would otherwise take a second successor.
 */

const EMBED_DIMENSION = 4;

const OCCURRED_AT = new Date('2026-08-01T00:00:00.000Z');
const NOW = new Date('2026-08-02T00:00:00.000Z');
const CLOSED_AT = new Date('2026-08-03T00:00:00.000Z');

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;

async function seedClaim(id: string): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Decision',
    id,
    now: NOW,
    occurredAt: OCCURRED_AT,
    properties: { text: id },
  });
}

async function closeClaim(id: string): Promise<void> {
  await runWrite(
    harness.driver,
    'MATCH (n:AionNode { id: $id }) SET n.valid_until = $at RETURN n.id AS id',
    { id, at: toGraphDateTime(CLOSED_AT) },
    (row) => row.id as string,
  );
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-claim-dedup-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  await seedClaim('claim-survivor');
  await seedClaim('claim-taken');
  await closeClaim('claim-taken');
  await seedClaim('claim-open');
}, 300_000);

afterAll(async () => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
  await stopNeo4jHarness(harness);
});

describe('the claim merge write', () => {
  it('abandons a pair whose loser another writer already closed', async () => {
    const result = await mergeClaimPair(harness.driver, {
      survivorId: 'claim-survivor',
      loserId: 'claim-taken',
      now: NOW,
    });

    expect(result.merged).toBe(false);
    expect(await supersedingNodeIds(harness.driver, 'claim-taken')).toEqual([]);
  });

  it('merges a pair both sides of which still hold currency', async () => {
    const result = await mergeClaimPair(harness.driver, {
      survivorId: 'claim-survivor',
      loserId: 'claim-open',
      now: NOW,
    });

    expect(result.merged).toBe(true);
    expect(await supersedingNodeIds(harness.driver, 'claim-open')).toEqual(['claim-survivor']);
  });
});
