import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { forgetNode, supersede, writeStampedNode } from './bitemporal.js';
import { upsertEdge } from './edges.js';
import { ENTITY_MENTION_TYPE, ENTITY_PARTICIPATION_TYPE } from './entity-mention-queries.js';
import { readEntityPairSignals, type EntityPairSignals } from './entity-signal-queries.js';
import { runGraphMigrations } from './migrations.js';
import type { RelationshipType } from './relationships.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from './test-support/neo4j-harness.fixture.js';
import { openSqliteHandle, type SqliteHandle } from '../sqlite/database.js';

/**
 * Tier 2's evidence, against a real server. Every number here is an identity predicate, and
 * Phase 1's lesson is that identity predicates never trust a fake graph: currency, edge
 * direction, and what a 1-hop neighbourhood actually contains are all properties of the store
 * rather than of a hand-written double.
 */

const EMBED_DIMENSION = 768;
const NOW = new Date('2026-09-01T00:00:00.000Z');

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;

async function entity(id: string, name: string): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Entity',
    id,
    now: NOW,
    properties: { name, name_norm: name.toLowerCase(), type: 'tool' },
  });
}

async function episode(id: string, occurredAt: string): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Episode',
    id,
    now: NOW,
    occurredAt: new Date(occurredAt),
    properties: { text: id },
  });
}

/** Both edges the mention stage writes, so the reads are held to the real edge shape. */
async function mentions(episodeId: string, entityId: string): Promise<void> {
  await upsertEdge(harness.driver, {
    type: ENTITY_MENTION_TYPE,
    sourceId: episodeId,
    targetId: entityId,
    strength: 1,
    confidence: 1,
    signals: ['episodic'],
    provenance: ['test'],
    count: 1,
    now: NOW,
  });
  await upsertEdge(harness.driver, {
    type: ENTITY_PARTICIPATION_TYPE,
    sourceId: entityId,
    targetId: episodeId,
    strength: 1,
    confidence: 1,
    signals: ['structural'],
    provenance: ['test'],
    count: 0,
    now: NOW,
  });
}

async function relate(
  sourceId: string,
  targetId: string,
  type: RelationshipType = 'RELATED_TO',
): Promise<void> {
  await upsertEdge(harness.driver, {
    type,
    sourceId,
    targetId,
    strength: 0.6,
    confidence: 0.8,
    signals: ['semantic'],
    provenance: ['test'],
    now: NOW,
  });
}

/** One pair, asserted present, so every case below reads a real row rather than an undefined. */
async function signalsFor(leftId: string, rightId: string): Promise<EntityPairSignals> {
  const [signals] = await readEntityPairSignals(harness.driver, [{ leftId, rightId }]);
  if (signals === undefined) {
    throw new Error(`no pair signals came back for ${leftId} and ${rightId}`);
  }
  return signals;
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-entity-signals-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  // Overlapping provenance: postgres and postgresql share two of the four episodes between
  // them, and share one neighbour out of three.
  await entity('postgres', 'Postgres');
  await entity('postgresql', 'PostgreSQL');
  await entity('psql', 'psql');
  await entity('pgbouncer', 'PgBouncer');
  await entity('timescale', 'Timescale');
  await episode('ep-1', '2026-08-01T00:00:00.000Z');
  await episode('ep-2', '2026-08-02T00:00:00.000Z');
  await episode('ep-3', '2026-08-03T00:00:00.000Z');
  await episode('ep-4', '2026-08-04T00:00:00.000Z');
  await mentions('ep-1', 'postgres');
  await mentions('ep-2', 'postgres');
  await mentions('ep-3', 'postgres');
  await mentions('ep-2', 'postgresql');
  await mentions('ep-3', 'postgresql');
  await mentions('ep-4', 'postgresql');
  await relate('postgres', 'psql');
  await relate('postgres', 'pgbouncer');
  await relate('postgresql', 'psql');
  await relate('postgresql', 'timescale');

  // Disjoint provenance, so the closest-episode gap is the only temporal evidence there is.
  await entity('redis', 'Redis');
  await entity('valkey', 'Valkey');
  await episode('ep-5', '2026-07-01T00:00:00.000Z');
  await episode('ep-6', '2026-07-04T12:00:00.000Z');
  await episode('ep-7', '2026-07-20T00:00:00.000Z');
  await mentions('ep-5', 'redis');
  await mentions('ep-6', 'valkey');
  await mentions('ep-7', 'valkey');
}, 300_000);

afterAll(async () => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
  await stopNeo4jHarness(harness);
});

describe('entity pair signals', () => {
  it('counts shared episodes and their Jaccard from the mention edges', async () => {
    const signals = await signalsFor('postgres', 'postgresql');

    expect(signals.sharedEpisodeIds).toEqual(['ep-2', 'ep-3']);
    expect(signals.sharedEpisodeCount).toBe(2);
    // Two shared over a union of four.
    expect(signals.sharedEpisodeJaccard).toBeCloseTo(0.5, 10);
  });

  it('reports the distinct-episode mention count per side', async () => {
    const signals = await signalsFor('postgres', 'postgresql');

    expect(signals.leftEpisodeCount).toBe(3);
    expect(signals.rightEpisodeCount).toBe(3);
  });

  it('overlaps 1-hop neighbourhoods without letting an episode in through a mention edge', async () => {
    const signals = await signalsFor('postgres', 'postgresql');

    // psql alone. The two also share ep-2 and ep-3, which are one hop away down MENTIONS and
    // PARTICIPATES_IN; counting them here would make the neighbour signal a second, noisier
    // reading of the provenance signal rather than independent evidence.
    expect(signals.neighborOverlapCount).toBe(1);
    expect(signals.neighborOverlapJaccard).toBeCloseTo(1 / 3, 10);
  });

  it('measures the closest-episode gap in days when the two sides share no episode', async () => {
    const signals = await signalsFor('redis', 'valkey');

    expect(signals.sharedEpisodeCount).toBe(0);
    expect(signals.sharedEpisodeJaccard).toBe(0);
    // ep-5 to ep-6 is three and a half days; ep-7 is further off and does not decide it.
    expect(signals.temporalGapDays).toBeCloseTo(3.5, 6);
  });

  it('answers a batch of pairs in one read, in the order it was asked', async () => {
    const signals = await readEntityPairSignals(harness.driver, [
      { leftId: 'redis', rightId: 'valkey' },
      { leftId: 'postgres', rightId: 'postgresql' },
    ]);

    expect(signals.map((row) => [row.leftId, row.rightId])).toEqual([
      ['redis', 'valkey'],
      ['postgres', 'postgresql'],
    ]);
  });

  it('reads nothing for an empty request', async () => {
    expect(await readEntityPairSignals(harness.driver, [])).toEqual([]);
  });

  it('drops a pair whose side lost currency, which is a pair with nothing left to merge', async () => {
    await entity('gone-left', 'Gone Left');
    await entity('gone-right', 'Gone Right');
    await entity('forgotten-left', 'Forgotten Left');
    await supersede(harness.driver, { oldId: 'gone-left', newId: 'gone-right', now: NOW });
    await forgetNode(harness.driver, { id: 'forgotten-left', now: NOW });

    expect(
      await readEntityPairSignals(harness.driver, [
        { leftId: 'gone-left', rightId: 'gone-right' },
        { leftId: 'forgotten-left', rightId: 'gone-right' },
        { leftId: 'no-such-entity', rightId: 'gone-right' },
      ]),
    ).toEqual([]);
  });

  it('leaves a superseded episode and a superseded neighbour out of both signals', async () => {
    await entity('kafka', 'Kafka');
    await entity('redpanda', 'Redpanda');
    await entity('shared-neighbour', 'Shared Neighbour');
    await entity('stale-neighbour', 'Stale Neighbour');
    await entity('neighbour-successor', 'Neighbour Successor');
    await episode('ep-8', '2026-06-01T00:00:00.000Z');
    await episode('ep-stale', '2026-06-02T00:00:00.000Z');
    await episode('ep-successor', '2026-06-03T00:00:00.000Z');
    await mentions('ep-8', 'kafka');
    await mentions('ep-8', 'redpanda');
    await mentions('ep-stale', 'kafka');
    await mentions('ep-stale', 'redpanda');
    await relate('kafka', 'shared-neighbour');
    await relate('redpanda', 'shared-neighbour');
    await relate('kafka', 'stale-neighbour');
    await relate('redpanda', 'stale-neighbour');
    await supersede(harness.driver, { oldId: 'ep-stale', newId: 'ep-successor', now: NOW });
    await supersede(harness.driver, {
      oldId: 'stale-neighbour',
      newId: 'neighbour-successor',
      now: NOW,
    });

    const signals = await signalsFor('kafka', 'redpanda');

    expect(signals.sharedEpisodeIds).toEqual(['ep-8']);
    expect(signals.leftEpisodeCount).toBe(1);
    expect(signals.rightEpisodeCount).toBe(1);
    expect(signals.neighborOverlapCount).toBe(1);
    expect(signals.neighborOverlapJaccard).toBe(1);
  });

  it('leaves the temporal gap absent when a side has no episode to measure against', async () => {
    await entity('unmentioned', 'Unmentioned');
    const signals = await signalsFor('postgres', 'unmentioned');

    expect(signals.temporalGapDays).toBeUndefined();
    expect(signals.rightEpisodeCount).toBe(0);
    expect(signals.sharedEpisodeJaccard).toBe(0);
    expect(signals.neighborOverlapJaccard).toBe(0);
  });
});
