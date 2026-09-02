import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { writeStampedNode } from './bitemporal.js';
import { runWrite } from './connection.js';
import {
  DESCRIPTION_RETIRED_AT_PROPERTY,
  PRIOR_DESCRIPTIONS_PROPERTY,
  refreshEntityDescription,
} from './entity-description-queries.js';
import { runGraphMigrations } from './migrations.js';
import { ENTITY_NAME_NORM_PROPERTY, ENTITY_NAME_PROPERTY } from './seed-queries.js';
import { nodeProperties } from './test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from './test-support/neo4j-harness.fixture.js';
import { toGraphDateTime } from './values.js';
import { openSqliteHandle, type SqliteHandle } from '../sqlite/database.js';

/**
 * The description rewrite sits across a model call, so the identity it read and the identity it
 * writes to are two different readings. A correction can retire the gloss in between, and a
 * merge can take the node's currency.
 */

const EMBED_DIMENSION = 4;

const OCCURRED_AT = new Date('2026-08-01T00:00:00.000Z');
const NOW = new Date('2026-08-02T00:00:00.000Z');
const REFRESHED_AT = new Date('2026-08-03T00:00:00.000Z');

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;

async function seedEntity(id: string, text: string | undefined): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Entity',
    id,
    now: NOW,
    occurredAt: OCCURRED_AT,
    properties: {
      [ENTITY_NAME_PROPERTY]: id,
      [ENTITY_NAME_NORM_PROPERTY]: id,
      ...(text === undefined ? {} : { text }),
    },
  });
}

async function refresh(id: string): Promise<boolean> {
  return refreshEntityDescription(harness.driver, {
    id,
    text: `a fresh gloss for ${id}`,
    contentVector: [0.1, 0.2, 0.3, 0.4],
    mentionCount: 4,
    now: REFRESHED_AT,
  });
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-entity-description-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  // A gloss a correction retired: the wording already moved to `prior_descriptions` and the
  // node carries no `text` at all.
  await seedEntity('retired-entity', undefined);
  await runWrite(
    harness.driver,
    [
      'MATCH (e:Entity { id: $id })',
      `SET e.${PRIOR_DESCRIPTIONS_PROPERTY} = $prior,`,
      `    e.${DESCRIPTION_RETIRED_AT_PROPERTY} = $at`,
      'RETURN e.id AS id',
    ].join('\n'),
    { id: 'retired-entity', prior: ['the gloss the correction closed'], at: toGraphDateTime(NOW) },
    (row) => row.id as string,
  );

  // An identity a merge absorbed while the re-synthesis was running.
  await seedEntity('absorbed-entity', 'the gloss the canonical now owns');
  await runWrite(
    harness.driver,
    'MATCH (e:Entity { id: $id }) SET e.valid_until = $at RETURN e.id AS id',
    { id: 'absorbed-entity', at: toGraphDateTime(NOW) },
    (row) => row.id as string,
  );
}, 300_000);

afterAll(async () => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
  await stopNeo4jHarness(harness);
});

describe('the description refresh write', () => {
  it('re-derives a retired gloss without storing a null among the prior ones', async () => {
    expect(await refresh('retired-entity')).toBe(true);

    const properties = await nodeProperties(harness.driver, 'retired-entity');
    expect(properties.text).toBe('a fresh gloss for retired-entity');
    expect(properties[PRIOR_DESCRIPTIONS_PROPERTY]).toEqual(['the gloss the correction closed']);
    expect(properties[DESCRIPTION_RETIRED_AT_PROPERTY]).toBeUndefined();
  });

  it('writes nothing to an identity that lost its currency', async () => {
    expect(await refresh('absorbed-entity')).toBe(false);

    const properties = await nodeProperties(harness.driver, 'absorbed-entity');
    expect(properties.text).toBe('the gloss the canonical now owns');
  });
});
