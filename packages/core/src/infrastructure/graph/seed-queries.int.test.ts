import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { writeStampedNode } from './bitemporal.js';
import { runWrite } from './connection.js';
import { addEntityAliases, linkEntityMentions, mergeEntities } from './entity-queries.js';
import { runGraphMigrations } from './migrations.js';
import { withCurrency } from './read-modes.js';
import { entityNameSeeds, EXACT_NAME_MATCH_SCORE } from './seed-queries.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from './test-support/neo4j-harness.fixture.js';
import { openSqliteHandle, type SqliteHandle } from '../sqlite/database.js';

/**
 * The entity-resolution seed leg against a real server. Alias membership is a Cypher list
 * predicate and the attribution back to the cue is a list comprehension, so neither is
 * provable against a fake graph.
 */

const EMBED_DIMENSION = 768;
const NOW = new Date('2026-08-31T00:00:00.000Z');

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let postgresId: string;
let redisId: string;

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-seed-queries-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  const merged = await mergeEntities(
    harness.driver,
    [
      {
        name: 'Postgres',
        nameNorm: 'postgres',
        type: 'tool',
        aliases: ['postgresql'],
        text: 'Postgres (tool): the store',
        sourceEpisodeId: 'seed-episode',
        extractionMethod: 'test',
        confidence: 0.8,
        occurredAt: NOW,
      },
      {
        name: 'Redis',
        nameNorm: 'redis',
        type: 'tool',
        text: 'Redis (tool): the cache',
        sourceEpisodeId: 'seed-episode',
        extractionMethod: 'test',
        confidence: 0.8,
        occurredAt: NOW,
      },
    ],
    NOW,
  );
  postgresId = merged.find((row) => row.nameNorm === 'postgres')?.id ?? '';
  redisId = merged.find((row) => row.nameNorm === 'redis')?.id ?? '';
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('entityNameSeeds', () => {
  it('answers an exact name at the ceiling, as it always has', async () => {
    const rows = await entityNameSeeds(harness.driver, {
      names: ['postgres'],
      mode: withCurrency(),
    });

    expect(rows.map((row) => row.id)).toEqual([postgresId]);
    expect(rows[0]?.score).toBe(EXACT_NAME_MATCH_SCORE);
    expect(rows[0]?.nameNorm).toBe('postgres');
  });

  it('keeps an absorbed name admissible through the identity that answers to it now', async () => {
    const rows = await entityNameSeeds(harness.driver, {
      names: ['postgresql'],
      mode: withCurrency(),
    });

    expect(rows.map((row) => row.id)).toEqual([postgresId]);
    // The cue is what the caller attributes the hit to, not the node's own spelling.
    expect(rows[0]?.nameNorm).toBe('postgresql');
    expect(rows[0]?.score).toBe(EXACT_NAME_MATCH_SCORE);
  });

  it('attributes to the exact cue when one node answers to two of them', async () => {
    const rows = await entityNameSeeds(harness.driver, {
      names: ['postgresql', 'postgres'],
      mode: withCurrency(),
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.nameNorm).toBe('postgres');
  });

  it('returns nothing for a name no identity answers to under either branch', async () => {
    const rows = await entityNameSeeds(harness.driver, {
      names: ['valkey'],
      mode: withCurrency(),
    });

    expect(rows).toEqual([]);
  });

  it('picks up an alias added after the node was written', async () => {
    await addEntityAliases(harness.driver, [
      { id: redisId, nameNorm: 'redis', aliases: ['the cache'] },
    ]);
    const rows = await entityNameSeeds(harness.driver, {
      names: ['the cache'],
      mode: withCurrency(),
    });

    expect(rows.map((row) => row.id)).toEqual([redisId]);
  });

  it('suppresses a forgotten holder exactly as the name branch does', async () => {
    await runWrite(
      harness.driver,
      'MATCH (n:Entity { id: $id }) SET n.forgotten_at = datetime() RETURN n.id AS id',
      { id: redisId },
      (row) => row.id as string,
    );

    const rows = await entityNameSeeds(harness.driver, {
      names: ['the cache', 'redis'],
      mode: withCurrency(),
    });

    expect(rows).toEqual([]);
  });
});

describe('mention counting', () => {
  it('counts distinct current episodes, dropping one the moment it is forgotten', async () => {
    await writeStampedNode(harness.driver, {
      label: 'Episode',
      id: 'mention-episode-1',
      now: NOW,
      properties: { text: 'text', session_id: 'session-1' },
    });
    await writeStampedNode(harness.driver, {
      label: 'Episode',
      id: 'mention-episode-2',
      now: NOW,
      properties: { text: 'text', session_id: 'session-1' },
    });
    for (const episodeId of ['mention-episode-1', 'mention-episode-2']) {
      await linkEntityMentions(harness.driver, {
        episodeId,
        entityIds: [postgresId],
        now: NOW,
        confidence: 1,
        provenance: ['test'],
      });
    }

    const [seeded] = await entityNameSeeds(harness.driver, {
      names: ['postgres'],
      mode: withCurrency(),
    });
    expect(seeded?.mentionCount).toBe(2);

    await runWrite(
      harness.driver,
      'MATCH (e:Episode { id: $id }) SET e.forgotten_at = datetime() RETURN e.id AS id',
      { id: 'mention-episode-2' },
      (row) => row.id as string,
    );

    const [afterForget] = await entityNameSeeds(harness.driver, {
      names: ['postgres'],
      mode: withCurrency(),
    });
    expect(afterForget?.mentionCount).toBe(1);
  });
});
