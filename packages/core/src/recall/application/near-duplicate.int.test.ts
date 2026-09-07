import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { supersede, writeStampedNode } from '../../infrastructure/graph/bitemporal.js';
import {
  CLAIM_ASPECT_PROPERTY,
  CLAIM_SUBJECT_PROPERTY,
} from '../../infrastructure/graph/claim-key-queries.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import { claimSimilarities } from '../../infrastructure/graph/near-duplicate-queries.js';
import { withCurrency } from '../../infrastructure/graph/read-modes.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import type { Vector } from '../../infrastructure/providers/types.js';
import { openSqliteHandle, type SqliteHandle } from '../../infrastructure/sqlite/database.js';

/**
 * The half of near-duplicate suppression that only a real graph can answer: which pairs of a
 * pack's candidates assert the same attribute of the same entity, and how close the two are.
 * What is done with the answer is `pack-duplicates.ts` and its own tests.
 *
 * The vectors are written rather than embedded. What is under test is the key match, the pairs
 * the query refuses to offer, and the rescale from what Neo4j reports back to a true cosine.
 */

const EMBED_DIMENSION = 8;
const AT = new Date('2026-06-01T09:00:00.000Z');
const CLOSED_AT = new Date('2026-06-05T09:00:00.000Z');

const SUBJECT = 'entity-seed-budget';
const OTHER_SUBJECT = 'entity-token-budget';
const ASPECT = 'default value';
const OTHER_ASPECT = 'owning team';

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;

/** Fractional components only: a whole number risks the driver encoding the property as an integer. */
function unit(components: Readonly<Record<number, number>>): Vector {
  const raw = new Array<number>(EMBED_DIMENSION).fill(0.001);
  for (const [index, value] of Object.entries(components)) {
    raw[Number(index)] = value;
  }
  const norm = Math.sqrt(raw.reduce((sum, value) => sum + value * value, 0));
  return raw.map((value) => value / norm);
}

const SAME = unit({ 0: 0.99 });
const NEARLY_SAME = unit({ 0: 0.99, 1: 0.02 });
const ORTHOGONAL = unit({ 3: 0.99 });

type ClaimInput = {
  readonly id: string;
  readonly vector?: Vector;
  readonly subject?: string;
  readonly aspect?: string;
};

async function writeClaim(input: ClaimInput): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Insight',
    id: input.id,
    now: AT,
    occurredAt: AT,
    properties: {
      text: input.id,
      ...(input.vector === undefined ? {} : { content_vec: [...input.vector] }),
      ...(input.subject === undefined ? {} : { [CLAIM_SUBJECT_PROPERTY]: input.subject }),
      ...(input.aspect === undefined ? {} : { [CLAIM_ASPECT_PROPERTY]: input.aspect }),
    },
  });
}

async function similarityBetween(ids: readonly string[]): Promise<Map<string, number>> {
  const rows = await claimSimilarities(harness.driver, { ids, mode: withCurrency() });
  return new Map(rows.map((row) => [`${row.left}|${row.right}`, row.similarity]));
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-near-duplicate-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  await writeClaim({ id: 'a-restated', vector: SAME, subject: SUBJECT, aspect: ASPECT });
  await writeClaim({ id: 'b-restated', vector: NEARLY_SAME, subject: SUBJECT, aspect: ASPECT });
  await writeClaim({ id: 'c-unrelated', vector: ORTHOGONAL, subject: SUBJECT, aspect: ASPECT });
  await writeClaim({ id: 'd-other-aspect', vector: SAME, subject: SUBJECT, aspect: OTHER_ASPECT });
  await writeClaim({ id: 'e-other-subject', vector: SAME, subject: OTHER_SUBJECT, aspect: ASPECT });
  await writeClaim({ id: 'f-unkeyed', vector: SAME });
  await writeClaim({ id: 'g-no-vector', subject: SUBJECT, aspect: ASPECT });

  await writeClaim({ id: 'h-closed', vector: SAME, subject: SUBJECT, aspect: OTHER_ASPECT });
  await writeClaim({
    id: 'i-successor',
    vector: NEARLY_SAME,
    subject: SUBJECT,
    aspect: OTHER_ASPECT,
  });
  await supersede(harness.driver, { oldId: 'h-closed', newId: 'i-successor', now: CLOSED_AT });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('claim similarity over a pack candidate set', () => {
  it('measures a true cosine between two claims carrying one subject key', async () => {
    const measured = await similarityBetween(['a-restated', 'b-restated', 'c-unrelated']);

    expect(measured.get('a-restated|b-restated')).toBeGreaterThan(0.99);
    expect(measured.get('a-restated|c-unrelated')).toBeLessThan(0.1);
  });

  it('offers no pair across a different aspect, a different subject, or no key at all', async () => {
    const measured = await similarityBetween([
      'a-restated',
      'd-other-aspect',
      'e-other-subject',
      'f-unkeyed',
      'g-no-vector',
    ]);

    expect([...measured.keys()]).toEqual([]);
  });

  it('offers no pair the judge already closed', async () => {
    const measured = await similarityBetween(['h-closed', 'i-successor']);

    expect([...measured.keys()]).toEqual([]);
  });

  it('asks nothing of the graph for a candidate set too small to hold a pair', async () => {
    expect(await claimSimilarities(harness.driver, { ids: [], mode: withCurrency() })).toEqual([]);
    expect(
      await claimSimilarities(harness.driver, { ids: ['a-restated'], mode: withCurrency() }),
    ).toEqual([]);
  });
});
