import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { STRUCTURAL_DISCOVERY_KNOB, structuralDiscoveryOperation } from './structural-discovery.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import type { Config } from '../../../infrastructure/config/schema.js';
import { writeStampedNode } from '../../../infrastructure/graph/bitemporal.js';
import { upsertEdge } from '../../../infrastructure/graph/edges.js';
import { ENTITY_MENTION_TYPE } from '../../../infrastructure/graph/entity-mention-queries.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import { countRelationships } from '../../../infrastructure/graph/test-support/graph-queries.fixture.js';
import { associationEdgeState } from '../../../infrastructure/graph/test-support/maintenance-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger, type Logger } from '../../../infrastructure/logging/logger.js';
import { refusingProvider } from '../../../infrastructure/providers/test-support/refusing-provider.fixture.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import type { OperationContext } from '../../domain/operation.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';

/**
 * Four pairs, one per case the discovery rule distinguishes: nominated with a shared episode
 * behind it, nominated with nothing but the cosine behind it, nominated but already connected,
 * and a pair whose sides are both too well connected to be a discovery candidate at all.
 *
 * Every vector here is written by hand so the nomination is a fact about the fixture rather
 * than about an embedding model: the two members of a pair point almost the same way, and the
 * pairs point away from each other.
 */

const EMBED_DIMENSION = 8;
const NOW = new Date('2026-09-02T00:00:00.000Z');
const BUCKET_STAMP = '2026-09-02';

let harness: Neo4jHarness;
let db: SqliteHandle;
let logger: Logger;
let dataDir: string;

/** The knob the operation gates on does not exist in the schema yet, so the test supplies it. */
const armed: Config = {
  ...DEFAULTS,
  maintenance: {
    ...DEFAULTS.maintenance,
    [STRUCTURAL_DISCOVERY_KNOB]: true,
  } as Config['maintenance'],
};

function context(config: Config = armed): OperationContext {
  return {
    driver: harness.driver,
    db,
    config,
    logger,
    provider: refusingProvider,
    health: healthFixture(),
    now: NOW,
    signal: new AbortController().signal,
  };
}

async function entity(id: string, vector?: readonly number[]): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Entity',
    id,
    now: NOW,
    properties: {
      name: id,
      name_norm: id,
      type: 'topic',
      ...(vector === undefined ? {} : { content_vec: [...vector] }),
    },
  });
}

async function episode(id: string): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Episode',
    id,
    now: NOW,
    properties: { text: id },
  });
}

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
}

async function associate(sourceId: string, targetId: string): Promise<void> {
  await upsertEdge(harness.driver, {
    type: 'CO_OCCURS',
    sourceId,
    targetId,
    strength: 0.5,
    confidence: 0.8,
    signals: ['test'],
    provenance: ['test'],
    count: 1,
    now: NOW,
  });
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-structural-discovery-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'error' });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  // Nominated and seconded: one episode names both, and nothing connects them.
  await entity('alpha', [1, 0.02, 0, 0, 0, 0, 0, 0]);
  await entity('beta', [0.98, 0.05, 0, 0, 0, 0, 0, 0]);
  await episode('ep-shared');
  await mentions('ep-shared', 'alpha');
  await mentions('ep-shared', 'beta');

  // Nominated and unseconded: no shared episode, no shared neighbour, unrelated names.
  await entity('gamma', [0, 0, 1, 0.02, 0, 0, 0, 0]);
  await entity('delta', [0, 0, 0.97, 0.06, 0, 0, 0, 0]);
  await episode('ep-gamma');
  await episode('ep-delta');
  await mentions('ep-gamma', 'gamma');
  await mentions('ep-delta', 'delta');

  // Nominated, seconded, and already joined: the pair the sweep has nothing left to discover.
  await entity('linked-a', [0, 0, 0, 0, 1, 0.02, 0, 0]);
  await entity('linked-b', [0, 0, 0, 0, 0.99, 0.04, 0, 0]);
  await episode('ep-linked');
  await mentions('ep-linked', 'linked-a');
  await mentions('ep-linked', 'linked-b');
  await associate('linked-a', 'linked-b');

  // Well connected on both sides: a shared episode and a high cosine, and still no candidate.
  await entity('hub-a', [0, 0, 0, 0, 0, 0, 1, 0.02]);
  await entity('hub-b', [0, 0, 0, 0, 0, 0, 0.98, 0.05]);
  await episode('ep-hub');
  await mentions('ep-hub', 'hub-a');
  await mentions('ep-hub', 'hub-b');
  for (const filler of ['filler-1', 'filler-2', 'filler-3']) {
    await entity(filler);
    await associate('hub-a', filler);
    await associate('hub-b', filler);
  }
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('structural_discovery', () => {
  it('examines nothing while the kill switch is off', async () => {
    const before = await countRelationships(harness.driver);
    const outcome = await structuralDiscoveryOperation().run(context(DEFAULTS));

    expect(outcome.status).toBe('noop');
    expect(outcome.itemsProcessed).toBe(0);
    expect(outcome.detail).toContain('AION_MAINTENANCE_STRUCTURAL_DISCOVERY');
    expect(await countRelationships(harness.driver)).toBe(before);
  });

  it('writes an association for a nominated pair a shared episode stands behind', async () => {
    const outcome = await structuralDiscoveryOperation().run(context());

    expect(outcome.status).toBe('applied');
    expect(outcome.itemsAffected).toBe(1);
    expect(outcome.detail).toContain(BUCKET_STAMP);

    const edge = await associationEdgeState(harness.driver, 'alpha', 'beta', 'CO_OCCURS');
    expect(edge?.signals).toContain('structural_discovery');
    expect(edge?.signals).toContain('shared_episode');
    expect(edge?.provenance).toContain('introspection');
    expect(edge?.rationale).toBe('both entities were named in the same episode');
  });

  it('drops the pair nothing but a cosine stands behind, and counts the drop', async () => {
    expect(
      await associationEdgeState(harness.driver, 'gamma', 'delta', 'CO_OCCURS'),
    ).toBeUndefined();

    const outcome = await structuralDiscoveryOperation().run(context());
    expect(outcome.detail).toContain('dropped 1 vector-only pair');
  });

  it('leaves a pair the graph already connects out of the nomination', async () => {
    const edge = await associationEdgeState(harness.driver, 'linked-a', 'linked-b', 'CO_OCCURS');

    expect(edge?.signals).not.toContain('structural_discovery');
    expect(edge?.strength).toBe(0.5);
  });

  it('leaves a well-connected pair alone however close its vectors are', async () => {
    expect(
      await associationEdgeState(harness.driver, 'hub-a', 'hub-b', 'CO_OCCURS'),
    ).toBeUndefined();
  });

  it('writes nothing new on a second run inside the same bucket', async () => {
    const before = await countRelationships(harness.driver);
    const outcome = await structuralDiscoveryOperation().run(context());

    expect(outcome.status).toBe('noop');
    expect(outcome.itemsAffected).toBe(0);
    expect(outcome.detail).toContain(BUCKET_STAMP);
    expect(await countRelationships(harness.driver)).toBe(before);
  });
});
