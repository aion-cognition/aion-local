import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BITEMPORAL_PROPERTIES, writeStampedNode } from './bitemporal.js';
import { writeCognitiveNode } from './cognitive-queries.js';
import { upsertEdge } from './edges.js';
import { EPISODE_PROPAGATION_METHOD, supersedeEpisode } from './episode-supersession.js';
import { runGraphMigrations } from './migrations.js';
import { SUPERSEDES_TYPE } from './relationships.js';
import { openSqliteHandle, type SqliteHandle } from '../sqlite/database.js';
import {
  nodeProperties,
  relationshipsByProvenance,
  supersedingNodeIds,
} from './test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from './test-support/neo4j-harness.fixture.js';

const EMBED_DIMENSION = 8;
const NOW = new Date('2026-08-28T12:00:00.000Z');

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;

async function seedEpisode(id: string): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Episode',
    id,
    now: NOW,
    properties: { text: `episode ${id}`, session_id: 'session-1' },
  });
}

async function seedDerived(episodeId: string, text: string): Promise<string> {
  const result = await writeCognitiveNode(harness.driver, {
    episodeId,
    label: 'Concept',
    text,
    occurredAt: NOW,
    now: NOW,
  });
  return result.node.id;
}

async function isClosed(id: string): Promise<boolean> {
  const properties = await nodeProperties(harness.driver, id);
  return properties[BITEMPORAL_PROPERTIES.validUntil] !== undefined;
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-episode-supersession-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('supersedeEpisode', () => {
  it('closes the episode and every fact whose only source it was, with lineage', async () => {
    await seedEpisode('ep-port-old');
    await seedEpisode('ep-port-new');
    const observation = await seedDerived('ep-port-old', 'Aion MCP service listens on port 9999.');
    const concept = await seedDerived('ep-port-old', 'The MCP port is 9999.');
    const survivor = await seedDerived('ep-port-new', 'The MCP port is 8765.');

    const result = await supersedeEpisode(harness.driver, {
      oldId: 'ep-port-old',
      newId: 'ep-port-new',
      now: NOW,
    });

    expect(result.supersession.oldId).toBe('ep-port-old');
    expect([...result.propagation.closedIds].sort()).toEqual([observation, concept].sort());
    expect(await isClosed('ep-port-old')).toBe(true);
    expect(await isClosed(observation)).toBe(true);
    expect(await isClosed(concept)).toBe(true);
    expect(await isClosed(survivor)).toBe(false);
    expect(await supersedingNodeIds(harness.driver, observation)).toEqual(['ep-port-new']);
    expect(await supersedingNodeIds(harness.driver, concept)).toEqual(['ep-port-new']);
  }, 120_000);

  it('leaves a fact another open episode also extracted', async () => {
    await seedEpisode('ep-shared-old');
    await seedEpisode('ep-shared-other');
    await seedEpisode('ep-shared-new');
    const shared = await seedDerived(
      'ep-shared-old',
      'Feature flags are evaluated at request start.',
    );
    await upsertEdge(harness.driver, {
      type: 'EXTRACTED_FROM',
      sourceId: shared,
      targetId: 'ep-shared-other',
      strength: 1,
      confidence: 1,
      signals: ['reflection'],
      provenance: ['cognitive-extraction'],
      count: 0,
      now: NOW,
    });

    const result = await supersedeEpisode(harness.driver, {
      oldId: 'ep-shared-old',
      newId: 'ep-shared-new',
      now: NOW,
    });

    expect(result.propagation.closedIds).toEqual([]);
    expect(await isClosed(shared)).toBe(false);
  }, 120_000);

  it('is a no-op on a repeat', async () => {
    await seedEpisode('ep-repeat-old');
    await seedEpisode('ep-repeat-new');
    const derived = await seedDerived('ep-repeat-old', 'The nightly job runs at 02:00 UTC.');

    await supersedeEpisode(harness.driver, {
      oldId: 'ep-repeat-old',
      newId: 'ep-repeat-new',
      now: NOW,
    });
    const closedAt = (await nodeProperties(harness.driver, derived))[
      BITEMPORAL_PROPERTIES.validUntil
    ];

    const repeat = await supersedeEpisode(harness.driver, {
      oldId: 'ep-repeat-old',
      newId: 'ep-repeat-new',
      now: new Date('2026-08-29T12:00:00.000Z'),
    });

    expect(repeat.propagation.closedIds).toEqual([]);
    expect(
      (await nodeProperties(harness.driver, derived))[BITEMPORAL_PROPERTIES.validUntil],
    ).toEqual(closedAt);
    expect(await supersedingNodeIds(harness.driver, derived)).toEqual(['ep-repeat-new']);
  }, 120_000);

  it('stamps propagation provenance, so lineage says why the fact closed', async () => {
    await seedEpisode('ep-prov-old');
    await seedEpisode('ep-prov-new');
    const derived = await seedDerived('ep-prov-old', 'The staging cluster runs three nodes.');

    await supersedeEpisode(harness.driver, {
      oldId: 'ep-prov-old',
      newId: 'ep-prov-new',
      now: NOW,
    });

    const properties = await nodeProperties(harness.driver, derived);
    expect(properties[BITEMPORAL_PROPERTIES.txUntil]).toBeDefined();
    const written = await relationshipsByProvenance(harness.driver, EPISODE_PROPAGATION_METHOD);
    expect(written).toContainEqual(
      expect.objectContaining({
        type: SUPERSEDES_TYPE,
        sourceId: 'ep-prov-new',
        targetId: derived,
      }),
    );
  }, 120_000);
});
