import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { supersede, writeStampedNode } from './bitemporal.js';
import { MEMORY_PROPERTIES } from './episodes.js';
import { scanHorizonIntegrity } from './horizon-integrity.js';
import { runGraphMigrations } from './migrations.js';
import { VALID_HORIZON_PROPERTY } from './read-modes.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from './test-support/neo4j-harness.fixture.js';
import { openSqliteHandle, type SqliteHandle } from '../sqlite/database.js';

const EMBED_DIMENSION = 8;

const OCCURRED_AT = new Date('2026-06-01T09:00:00.000Z');

const HORIZON = new Date('2026-07-01T09:00:00.000Z');

/** When the correcting experience happened, which is what a real close stamps. */
const CORRECTED_AT = new Date('2026-06-20T15:00:00.000Z');

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;

async function seedReading(id: string, properties: Record<string, unknown> = {}): Promise<string> {
  await writeStampedNode(harness.driver, {
    label: 'Concept',
    id,
    now: OCCURRED_AT,
    occurredAt: OCCURRED_AT,
    properties: {
      [MEMORY_PROPERTIES.text]: `reading ${id}`,
      [VALID_HORIZON_PROPERTY]: HORIZON,
      ...properties,
    },
  });
  return id;
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-horizon-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('the horizon integrity scan', () => {
  it('counts nothing against a substrate that has written no horizon', async () => {
    await writeStampedNode(harness.driver, {
      label: 'Concept',
      id: 'standing-owner',
      now: OCCURRED_AT,
      occurredAt: OCCURRED_AT,
      properties: { [MEMORY_PROPERTIES.text]: 'the pipeline is owned by the platform group' },
    });

    expect(await scanHorizonIntegrity(harness.driver)).toEqual({
      withHorizon: 0,
      closed: 0,
      closedAtHorizon: 0,
      sampleIds: [],
    });
  });

  it('counts an open reading as carrying a horizon and nothing else', async () => {
    await seedReading('reading-open');

    expect(await scanHorizonIntegrity(harness.driver)).toEqual({
      withHorizon: 1,
      closed: 0,
      closedAtHorizon: 0,
      sampleIds: [],
    });
  });

  /**
   * A reading a later observation corrected carries both properties, and that is the ordinary
   * shape: the close records when the correcting experience happened, which has nothing to do
   * with the horizon the reading was written with.
   */
  it('reports a corrected reading as closed and holds the integrity line', async () => {
    await seedReading('reading-corrected');
    await writeStampedNode(harness.driver, {
      label: 'Concept',
      id: 'reading-successor',
      now: CORRECTED_AT,
      occurredAt: CORRECTED_AT,
      properties: { [MEMORY_PROPERTIES.text]: 'the queue holds 5.1 million rows' },
    });
    await supersede(harness.driver, {
      oldId: 'reading-corrected',
      newId: 'reading-successor',
      now: CORRECTED_AT,
      validUntil: CORRECTED_AT,
    });

    const report = await scanHorizonIntegrity(harness.driver);
    expect(report.withHorizon).toBe(2);
    expect(report.closed).toBe(1);
    expect(report.closedAtHorizon).toBe(0);
    expect(report.sampleIds).toEqual([]);
  });

  /**
   * The one shape the horizon must never take. A close stamped at the horizon is a horizon
   * written as `valid_until`, which is invisible to every currency predicate in the tree and
   * permanent under the coalesce on the next real close.
   */
  it('names a node whose close is its own horizon', async () => {
    await seedReading('reading-closed-at-horizon', { valid_until: HORIZON });

    const report = await scanHorizonIntegrity(harness.driver);
    expect(report.withHorizon).toBe(3);
    expect(report.closed).toBe(2);
    expect(report.closedAtHorizon).toBe(1);
    expect(report.sampleIds).toEqual(['reading-closed-at-horizon']);
  });
});
