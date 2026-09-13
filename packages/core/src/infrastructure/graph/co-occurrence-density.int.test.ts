import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { linkCoOccurrence } from './association-queries.js';
import { writeStampedNode } from './bitemporal.js';
import { runGraphMigrations } from './migrations.js';
import { coOccurrencePairs } from './test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from './test-support/neo4j-harness.fixture.js';
import {
  coOccurrenceBirthStrength,
  coOccurringPairs,
} from '../../reflection/domain/associations.js';
import { DEFAULTS } from '../config/defaults.js';
import { openSqliteHandle, type SqliteHandle } from '../sqlite/database.js';

/**
 * Co-occurrence density weighting against a real merge policy: how weak a dense episode's births
 * are, and what repetition does to one of them.
 *
 * The bounded-step policy the write goes through is not new here and is asserted as a control:
 * the density formula is only a weighting if a repeated observation steps from the strength it
 * finds rather than restating a maximum.
 */

const FLOOR = DEFAULTS.hebbian.weightFloor;
const NOW = new Date('2026-09-13T12:00:00.000Z');

let harness: Neo4jHarness;
let db: SqliteHandle;

type NamedEntity = { readonly id: string; readonly name: string };

async function entity(name: string): Promise<NamedEntity> {
  const node = await writeStampedNode(harness.driver, {
    label: 'Entity',
    now: NOW,
    occurredAt: NOW,
    properties: { name, name_norm: name.toLowerCase(), type: 'concept' },
  });
  return { id: node.id, name };
}

/** One episode's worth of co-occurrence, written the way the stage writes it. */
async function observeEpisode(entities: readonly NamedEntity[]): Promise<number> {
  const pairs = coOccurringPairs(entities.map((row) => row.id));
  const strength = coOccurrenceBirthStrength(pairs.length, FLOOR);
  for (const pair of pairs) {
    await linkCoOccurrence(harness.driver, {
      sourceId: pair.sourceId,
      targetId: pair.targetId,
      observationStrength: strength,
      weightFloor: FLOOR,
      now: NOW,
    });
  }
  return strength;
}

async function strengthBetween(left: NamedEntity, right: NamedEntity): Promise<number | undefined> {
  const pairs = await coOccurrencePairs(harness.driver);
  return pairs.find(
    (pair) =>
      (pair.a === left.name && pair.b === right.name) ||
      (pair.a === right.name && pair.b === left.name),
  )?.strength;
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  db = openSqliteHandle({ filePath: ':memory:' });
  await runGraphMigrations(harness.driver, db, {
    embedDimension: DEFAULTS.models.embedDimension,
  });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
});

describe('co-occurrence births', () => {
  it('mints a thirty-entity episode at the floor and a two-entity episode at full strength', async () => {
    const dense: NamedEntity[] = [];
    for (let index = 0; index < 30; index += 1) {
      dense.push(await entity(`dense-${String(index)}`));
    }
    const minted = await observeEpisode(dense);

    expect(minted).toBe(FLOOR);
    expect(coOccurringPairs(dense.map((row) => row.id))).toHaveLength(435);
    expect(await strengthBetween(dense[0]!, dense[1]!)).toBeCloseTo(FLOOR, 10);

    const focused = [await entity('focused-a'), await entity('focused-b')];
    expect(await observeEpisode(focused)).toBe(1);
    expect(await strengthBetween(focused[0]!, focused[1]!)).toBe(1);
  }, 300_000);

  it('climbs a pair that recurs across three episodes and leaves the rest at the floor', async () => {
    const recurring = [await entity('recur-a'), await entity('recur-b')];
    const filler: NamedEntity[] = [];
    for (let index = 0; index < 8; index += 1) {
      filler.push(await entity(`filler-${String(index)}`));
    }

    // Three dense episodes, each naming the recurring pair among nine other entities, so every
    // birth in all three lands on the plateau and nothing about the pair is special at birth.
    for (let round = 0; round < 3; round += 1) {
      await observeEpisode([...recurring, ...filler.slice(round, round + 4)]);
    }

    const climbed = await strengthBetween(recurring[0]!, recurring[1]!);
    const once = await strengthBetween(filler[0]!, filler[1]!);

    // Three bounded steps from zero at the floor rate: 0.1, 0.19, 0.271.
    expect(climbed).toBeCloseTo(1 - (1 - FLOOR) ** 3, 10);
    expect(once).toBeCloseTo(FLOOR, 10);
    expect(climbed!).toBeGreaterThan(once!);
  }, 300_000);

  it('steps a repeated observation from the strength it finds, rather than restating a maximum', async () => {
    const pair = [await entity('step-a'), await entity('step-b')];

    await linkCoOccurrence(harness.driver, {
      sourceId: pair[0]!.id,
      targetId: pair[1]!.id,
      observationStrength: 0.2,
      weightFloor: FLOOR,
      now: NOW,
    });
    expect(await strengthBetween(pair[0]!, pair[1]!)).toBeCloseTo(0.2, 10);

    await linkCoOccurrence(harness.driver, {
      sourceId: pair[0]!.id,
      targetId: pair[1]!.id,
      observationStrength: 0.2,
      weightFloor: FLOOR,
      now: NOW,
    });

    expect(await strengthBetween(pair[0]!, pair[1]!)).toBeCloseTo(0.2 + 0.2 * 0.8, 10);
  }, 300_000);
});
