import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { writeStampedNode } from './bitemporal.js';
import { inWriteTransaction } from './connection.js';
import { GraphNodeNotFoundError } from './errors.js';
import { LOCK_PROPERTY, lockNodeInTransaction } from './locks.js';
import { runGraphMigrations } from './migrations.js';
import { nodeProperties } from './test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from './test-support/neo4j-harness.fixture.js';
import { openSqliteHandle, type SqliteHandle } from '../sqlite/database.js';

/**
 * Taking a node's exclusive lock is a write, so whether the MATCH bound anything is only
 * answerable against a real server.
 */

const EMBED_DIMENSION = 8;
const NOW = new Date('2026-09-01T11:00:00.000Z');

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-locks-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  await writeStampedNode(harness.driver, {
    label: 'Session',
    id: 'lock-session',
    now: NOW,
    properties: { started_at: NOW.toISOString() },
  });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('lockNodeInTransaction', () => {
  it('stamps the node it locked', async () => {
    await inWriteTransaction(harness.driver, async (tx) => {
      await lockNodeInTransaction(tx, 'lock-session', NOW);
    });

    expect((await nodeProperties(harness.driver, 'lock-session'))[LOCK_PROPERTY]).toBeDefined();
  }, 120_000);

  it('refuses an id that names no node rather than reporting a lock it never took', async () => {
    await expect(
      inWriteTransaction(harness.driver, async (tx) => {
        await lockNodeInTransaction(tx, 'no-such-node', NOW);
      }),
    ).rejects.toThrow(GraphNodeNotFoundError);
  }, 120_000);
});
