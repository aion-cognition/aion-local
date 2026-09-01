import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { redirectAndAbsorb } from './entity-dedup-queries.js';
import { mergeEntities, type EntityMergeInput } from './entity-queries.js';
import { runGraphMigrations } from './migrations.js';
import { withCurrency } from './read-modes.js';
import { entityNameSeeds, EXACT_NAME_MATCH_SCORE } from './seed-queries.js';
import { storedEntities, type StoredEntity } from './test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from './test-support/neo4j-harness.fixture.js';
import { openSqliteHandle, type SqliteHandle } from '../sqlite/database.js';

/**
 * The identity re-key against a real server. Every property here is a claim about what the
 * `entity_name_unique` constraint and the MERGE do together under a live lock manager: the
 * serialization two concurrent writers get, the counted readings a matched node accumulates,
 * and the chain walk that keeps a merged-away name from reviving its own node. None of it is
 * provable against a fake graph, which is the one place aion-go's identity work went wrong.
 */

const EMBED_DIMENSION = 768;
const NOW = new Date('2026-08-31T00:00:00.000Z');
const OCCURRED_AT = new Date('2026-08-30T00:00:00.000Z');

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;

function reading(name: string, type: string): EntityMergeInput {
  return {
    name,
    nameNorm: name.toLowerCase(),
    type,
    text: `${name} (${type})`,
    sourceEpisodeId: 'identity-episode',
    extractionMethod: 'test',
    confidence: 0.8,
    occurredAt: OCCURRED_AT,
  };
}

function countsOf(serialized: string | null): Record<string, number> {
  return JSON.parse(serialized ?? '{}') as Record<string, number>;
}

async function entitiesNamed(nameNorm: string): Promise<StoredEntity[]> {
  const stored = await storedEntities(harness.driver);
  return stored.filter((entity) => entity.nameNorm === nameNorm);
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-entity-identity-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('one name under concurrent writers', () => {
  it('gives four simultaneous runs a single node and counts every reading once', async () => {
    const results = await Promise.all(
      ['tool', 'topic', 'project', 'person'].map(async (type) =>
        mergeEntities(harness.driver, [reading('Harbor Index', type)], NOW),
      ),
    );

    // The constraint is what makes the MERGE a seek: the writer that loses the race blocks on
    // the index entry and matches, rather than committing a second node under the same name.
    expect(new Set(results.map((rows) => rows[0]?.id)).size).toBe(1);

    const stored = await entitiesNamed('harbor index');
    expect(stored).toHaveLength(1);
    // One reading from the run that created the node, one from each run that matched it. A
    // lost update would leave fewer, since every delta is read and written under one lock.
    expect(countsOf(stored[0]?.typeCounts ?? null)).toEqual({
      person: 1,
      project: 1,
      tool: 1,
      topic: 1,
    });
  });
});

describe('the label follows the readings', () => {
  it('converges on the most-observed type without forking the node', async () => {
    const created = await mergeEntities(harness.driver, [reading('Ledger Sweep', 'tool')], NOW);
    const id = created[0]?.id;

    for (const type of ['topic', 'topic']) {
      await mergeEntities(harness.driver, [reading('Ledger Sweep', type)], NOW);
    }

    const stored = await entitiesNamed('ledger sweep');
    expect(stored).toHaveLength(1);
    expect(stored[0]?.id).toBe(id);
    expect(stored[0]?.typeCounts).toBe('{"tool":1,"topic":2}');
    expect(stored[0]?.type).toBe('topic');
  });

  it('leaves the incumbent standing when the readings are even', async () => {
    await mergeEntities(harness.driver, [reading('Tie Break', 'tool')], NOW);
    await mergeEntities(harness.driver, [reading('Tie Break', 'topic')], NOW);

    const stored = await entitiesNamed('tie break');
    expect(stored).toHaveLength(1);
    expect(stored[0]?.typeCounts).toBe('{"tool":1,"topic":1}');
    expect(stored[0]?.type).toBe('tool');
  });
});

describe('a name a merge absorbed', () => {
  let canonicalId: string;
  let absorbedId: string;

  beforeAll(async () => {
    const merged = await mergeEntities(
      harness.driver,
      [reading('Postgres', 'tool'), reading('PostgreSQL', 'tool')],
      NOW,
    );
    canonicalId = merged.find((row) => row.nameNorm === 'postgres')?.id ?? '';
    absorbedId = merged.find((row) => row.nameNorm === 'postgresql')?.id ?? '';

    await redirectAndAbsorb(harness.driver, {
      canonicalId,
      canonicalNameNorm: 'postgres',
      mergedIds: [absorbedId],
      aliases: ['PostgreSQL'],
      accessCount: 0,
      now: NOW,
    });
  });

  it('keeps answering recall through the identity that holds it now', async () => {
    const rows = await entityNameSeeds(harness.driver, {
      names: ['postgresql'],
      mode: withCurrency(),
    });

    // Without the alias branch this cue reaches only the node the merge closed, and an
    // exact-name admission spends itself on a dead identity.
    const canonical = rows.find((row) => row.id === canonicalId);
    expect(canonical?.currency).toBe('current');
    expect(canonical?.score).toBe(EXACT_NAME_MATCH_SCORE);
    // The cue is what the hit attributes to, not the identity's own spelling.
    expect(canonical?.nameNorm).toBe('postgresql');

    // The read is currency-aware rather than currency-filtered, so the absorbed node still
    // comes back; what makes it harmless is the lineage riding with it.
    const absorbed = rows.find((row) => row.id === absorbedId);
    expect(absorbed?.currency).toBe('superseded');
    expect(absorbed?.supersededBy?.id).toBe(canonicalId);
  });

  it('routes a later extraction of that spelling forward instead of reviving the duplicate', async () => {
    const merged = await mergeEntities(harness.driver, [reading('PostgreSQL', 'tool')], NOW);

    expect(merged[0]?.id).toBe(canonicalId);
    expect(merged[0]?.canonicalNameNorm).toBe('postgres');
    expect(merged[0]?.created).toBe(false);

    // The closed node still owns the key, which is why the MERGE cannot carry a currency
    // predicate and why the chain walk is what makes the merge stick.
    const absorbed = await entitiesNamed('postgresql');
    expect(absorbed.map((entity) => entity.id)).toEqual([absorbedId]);
  });
});
