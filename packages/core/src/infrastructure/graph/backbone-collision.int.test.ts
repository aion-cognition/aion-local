import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bootstrapBackbone, SUBSTRATE_NAME } from './backbone.js';
import { runRead } from './connection.js';
import { runGraphMigrations } from './migrations.js';
import { seedBareEntity } from './test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from './test-support/neo4j-harness.fixture.js';
import { openSqliteHandle, type SqliteHandle } from '../sqlite/database.js';

const EMBED_DIMENSION = 8;
const NOW = new Date('2026-09-05T12:00:00.000Z');

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-backbone-collision-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function substrateCount(): Promise<number> {
  const rows = await runRead(
    harness.driver,
    'MATCH (n:Substrate) RETURN count(n) AS c',
    {},
    (row) => row.c as number,
  );
  return Number(rows[0] ?? 0);
}

describe('backbone bootstrap on a graph that already names the substrate', () => {
  it('keeps the member entity and skips the substrate node instead of fighting the name constraint', async () => {
    await seedBareEntity(harness.driver, { id: 'organic-aion', name: SUBSTRATE_NAME, now: NOW });

    const result = await bootstrapBackbone(harness.driver, { memberName: 'Ryan Huber', now: NOW });

    expect(result.member.created).toBe(true);
    expect(result.workspace.created).toBe(true);
    expect(result.substrate).toBeUndefined();
    expect(await substrateCount()).toBe(0);

    const organic = await runRead(
      harness.driver,
      'MATCH (e:Entity {id: $id}) RETURN e.name AS name, labels(e) AS labels',
      { id: 'organic-aion' },
      (row) => ({ name: row.name as string, labels: row.labels as string[] }),
    );
    expect(organic[0]?.name).toBe(SUBSTRATE_NAME);
    expect(organic[0]?.labels).not.toContain('Substrate');
  });

  it('skips again on a rerun rather than erroring, and leaves the graph unchanged', async () => {
    const rerun = await bootstrapBackbone(harness.driver, { memberName: 'Ryan Huber', now: NOW });

    expect(rerun.member.created).toBe(false);
    expect(rerun.substrate).toBeUndefined();
    expect(await substrateCount()).toBe(0);
  });
});
