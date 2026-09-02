import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { supersede, writeStampedNode } from './bitemporal.js';
import { MEMORY_PROPERTIES } from './episodes.js';
import { runGraphMigrations } from './migrations.js';
import { findPendingVectorNodes, writeContentVectors } from './pending-vectors.js';
import { nodeProperties } from './test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from './test-support/neo4j-harness.fixture.js';
import { openSqliteHandle, type SqliteHandle } from '../sqlite/database.js';

/**
 * The vector drain's write half against a real server. Embedding is a network call between the
 * read that chose the batch and the write that lands it, so the race this covers is the one
 * where a node closes in that window.
 */

const EMBED_DIMENSION = 8;
const VECTOR = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
const NOW = new Date('2026-09-01T09:00:00.000Z');
const MERGED_AT = new Date('2026-09-01T09:30:00.000Z');

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-pending-vectors-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  for (const id of ['pv-duplicate', 'pv-canonical', 'pv-open']) {
    await writeStampedNode(harness.driver, {
      label: 'Concept',
      id,
      now: NOW,
      properties: { [MEMORY_PROPERTIES.text]: `text of ${id}` },
    });
  }
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('writing a drained batch back', () => {
  it('skips a node that closed between the read and the write', async () => {
    const pending = await findPendingVectorNodes(harness.driver, 10);
    expect(pending.map((node) => node.id).sort()).toEqual([
      'pv-canonical',
      'pv-duplicate',
      'pv-open',
    ]);

    // The window the embed call opens: dedup absorbs the duplicate while the batch is out.
    await supersede(harness.driver, {
      oldId: 'pv-duplicate',
      newId: 'pv-canonical',
      now: MERGED_AT,
      signals: ['entity_merge'],
    });

    const written = await writeContentVectors(
      harness.driver,
      pending.map((node) => ({ id: node.id, vector: VECTOR, inputHash: 'a'.repeat(64) })),
    );

    expect(written.sort()).toEqual(['pv-canonical', 'pv-open']);
    const duplicate = await nodeProperties(harness.driver, 'pv-duplicate');
    expect(duplicate[MEMORY_PROPERTIES.contentVector]).toBeUndefined();
    expect(duplicate[MEMORY_PROPERTIES.contentVectorHash]).toBeUndefined();
  }, 120_000);
});
