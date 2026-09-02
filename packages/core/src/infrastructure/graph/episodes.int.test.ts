import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { forgetNode, writeStampedNode } from './bitemporal.js';
import { upsertEdge } from './edges.js';
import { CONTAINMENT_TYPE, findEpisodeByContentHash, MEMORY_PROPERTIES } from './episodes.js';
import { runGraphMigrations } from './migrations.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from './test-support/neo4j-harness.fixture.js';
import { openSqliteHandle, type SqliteHandle } from '../sqlite/database.js';

/**
 * Intake resolves a re-pushed payload to the episode that already holds its content hash. A
 * forgotten episode is suppressed everywhere else the substrate reads, and it must not answer
 * here either: an episode a person forgot would otherwise claim the hash forever and the
 * re-pushed experience would never be stored.
 */

const EMBED_DIMENSION = 4;

const OCCURRED_AT = new Date('2026-08-01T00:00:00.000Z');
const NOW = new Date('2026-08-02T00:00:00.000Z');

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;

async function seedEpisode(id: string, contentHash: string): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Episode',
    id,
    now: NOW,
    occurredAt: OCCURRED_AT,
    properties: {
      text: id,
      [MEMORY_PROPERTIES.sessionId]: 'session-1',
      [MEMORY_PROPERTIES.contentHash]: contentHash,
    },
  });
  await upsertEdge(harness.driver, {
    type: CONTAINMENT_TYPE,
    sourceId: id,
    targetId: 'session-1',
    strength: 1,
    confidence: 1,
    signals: ['test'],
    provenance: ['test'],
    count: 0,
    now: NOW,
  });
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-episodes-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  await writeStampedNode(harness.driver, {
    label: 'Session',
    id: 'session-1',
    now: NOW,
    properties: { name: 'session-1' },
  });
  await seedEpisode('ep-kept', 'hash-kept');
  await seedEpisode('ep-forgotten', 'hash-forgotten');
  await forgetNode(harness.driver, { id: 'ep-forgotten', now: NOW });
}, 300_000);

afterAll(async () => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
  await stopNeo4jHarness(harness);
});

describe('the content-hash dedupe read', () => {
  it('resolves a re-pushed payload to the episode still holding its hash', async () => {
    const found = await findEpisodeByContentHash(harness.driver, {
      sessionId: 'session-1',
      contentHash: 'hash-kept',
    });

    expect(found).toBe('ep-kept');
  });

  it('lets a forgotten episode go, so the same payload can be stored again', async () => {
    const found = await findEpisodeByContentHash(harness.driver, {
      sessionId: 'session-1',
      contentHash: 'hash-forgotten',
    });

    expect(found).toBeUndefined();
  });
});
