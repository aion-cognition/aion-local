import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyEntityMerge } from './entity-merge-writer.js';
import { recordAccess } from '../../infrastructure/graph/access-tracking.js';
import { writeStampedNode } from '../../infrastructure/graph/bitemporal.js';
import { loadEntityDedupDetails } from '../../infrastructure/graph/entity-dedup-queries.js';
import { addEntityAliases } from '../../infrastructure/graph/entity-identity-queries.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import {
  accessMetadata,
  storedEntity,
} from '../../infrastructure/graph/test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger, type Logger } from '../../infrastructure/logging/logger.js';
import { openSqliteHandle, type SqliteHandle } from '../../infrastructure/sqlite/database.js';

/**
 * What the merge write does to properties other writers are moving at the same time. The
 * cascade decides on one detail load taken at stage start and can take minutes to reach the
 * write; alias routing and recall's access tracking reach the same canonical in that window
 * and take no lock, so only a real server can say whose value survives.
 */

const EMBED_DIMENSION = 8;
const SEEDED_AT = new Date('2026-09-01T00:00:00.000Z');
/** When the cascade loaded its details. */
const SNAPSHOT_AT = new Date('2026-09-01T00:01:00.000Z');
/** While the cascade was still deciding. */
const CONCURRENT_AT = new Date('2026-09-01T00:06:00.000Z');
const MERGE_AT = new Date('2026-09-01T00:07:00.000Z');

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let logger: Logger;

async function seedEntity(id: string): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Entity',
    id,
    properties: { name: id, name_norm: id, type: 'concept' },
    now: SEEDED_AT,
  });
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-entity-merge-writer-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'error' });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('a merge whose canonical was written to after the decision snapshot', () => {
  it('keeps the concurrent alias, count and access time rather than the snapshot', async () => {
    await seedEntity('absorb-canon');
    await seedEntity('absorb-dup');
    await addEntityAliases(harness.driver, [
      { id: 'absorb-canon', nameNorm: 'absorb-canon', aliases: ['Snapshot Alias'] },
    ]);
    await recordAccess(harness.driver, { ids: ['absorb-canon'], now: SNAPSHOT_AT });
    await recordAccess(harness.driver, { ids: ['absorb-dup'], now: SNAPSHOT_AT });

    // The one detail load the whole stage decides on.
    const snapshot = await loadEntityDedupDetails(harness.driver, ['absorb-canon', 'absorb-dup']);
    const canonical = snapshot.find((detail) => detail.id === 'absorb-canon');
    if (canonical === undefined) {
      throw new Error('the canonical did not load');
    }

    // Two ordinary writers reach the canonical while the cascade is still deciding: an alias
    // routing and two recalls. Neither takes a lock, and both commit before the merge starts.
    await addEntityAliases(harness.driver, [
      { id: 'absorb-canon', nameNorm: 'absorb-canon', aliases: ['Concurrent Alias'] },
    ]);
    await recordAccess(harness.driver, { ids: ['absorb-canon'], now: CONCURRENT_AT });
    await recordAccess(harness.driver, { ids: ['absorb-canon'], now: CONCURRENT_AT });

    const result = await applyEntityMerge(
      { driver: harness.driver, db, logger },
      {
        canonical,
        members: snapshot,
        tier: 'tier0',
        reasons: ['test'],
        signals: [],
        method: 'test',
        now: MERGE_AT,
      },
    );
    expect(result.status).toBe('merged');

    // The merge absorbs, it does not overwrite: the spelling that arrived after the snapshot
    // still routes, the count carries all three recalls plus the absorbed identity's one, and
    // the access time never moves backwards.
    const stored = await storedEntity(harness.driver, 'absorb-canon');
    expect([...(stored?.aliases ?? [])].sort()).toEqual([
      'Concurrent Alias',
      'Snapshot Alias',
      'absorb-dup',
    ]);
    expect(stored?.accessCount).toBe(4);
    expect((await accessMetadata(harness.driver, 'absorb-canon')).lastAccessed).toEqual(
      CONCURRENT_AT,
    );
  });
});
