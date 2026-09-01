import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { mergeAutoOperation } from './merge-auto-operation.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import type { Config } from '../../../infrastructure/config/schema.js';
import { addEntityAliases } from '../../../infrastructure/graph/entity-identity-queries.js';
import {
  mergeEntities,
  type EntityMergeInput,
} from '../../../infrastructure/graph/entity-queries.js';
import {
  countAutoMergedEntities,
  wasEntityMergeApplied,
} from '../../../infrastructure/graph/merge-shadow-queries.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import {
  storedEntity,
  supersessionEdge,
} from '../../../infrastructure/graph/test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger } from '../../../infrastructure/logging/logger.js';
import { refusingProvider } from '../../../infrastructure/providers/test-support/refusing-provider.fixture.js';
import { foldName } from '../../../infrastructure/providers/unicode-fold.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import { findEntityMergeDecisionsForEntity } from '../../../infrastructure/sqlite/entity-merge-decisions.js';
import type { OperationContext } from '../../domain/operation.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';

/**
 * `merge_auto` is tier 0 swept over the whole graph, so every case here turns on a predicate
 * the server answers: the squashed name key, the alias index, and currency. A refusing provider
 * stands in for the model on purpose, since a tier-0 merge that asked one would fail the run.
 */

const EMBED_DIMENSION = 8;
const NOW = new Date('2026-08-29T13:00:00.000Z');

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;

async function seedEntity(name: string, type: string): Promise<string> {
  const entity: EntityMergeInput = {
    name,
    nameNorm: foldName(name),
    type,
    text: `${name} (${type})`,
    sourceEpisodeId: 'seed-episode',
    extractionMethod: 'test',
    confidence: 0.8,
    occurredAt: NOW,
  };
  const [merged] = await mergeEntities(harness.driver, [entity], NOW);
  if (merged === undefined) {
    throw new Error(`failed to seed entity ${name}`);
  }
  return merged.id;
}

function contextFor(config: Config = DEFAULTS): OperationContext {
  return {
    driver: harness.driver,
    db,
    config,
    logger: openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' }),
    provider: refusingProvider,
    health: healthFixture(),
    now: NOW,
    signal: new AbortController().signal,
  };
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-merge-auto-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('mergeAutoOperation against a live graph', () => {
  let dashedId: string;
  let spacedId: string;

  it('merges the separator spelling, leaves the merely similar pair alone, and counts it', async () => {
    dashedId = await seedEntity('ledger-cache', 'tool');
    spacedId = await seedEntity('ledger cache', 'topic');
    const loaderId = await seedEntity('Fenwick Loader', 'tool');
    const batchId = await seedEntity('Fenwick Batch', 'topic');

    const outcome = await mergeAutoOperation().run(contextFor());

    expect(outcome.status).toBe('applied');
    expect(outcome.itemsProcessed).toBe(1);
    expect(outcome.itemsAffected).toBe(1);
    expect(outcome.detail).toBe('1 identity(ies) merged across 1 deterministic group(s)');

    expect(await wasEntityMergeApplied(harness.driver, dashedId, spacedId)).toBe(true);
    const edge =
      (await supersessionEdge(harness.driver, dashedId)) ??
      (await supersessionEdge(harness.driver, spacedId));
    expect(edge?.signals).toEqual(['entity_merge']);
    expect(edge?.provenance).toEqual(['auto_merge']);

    // The names that merely resemble each other key apart and stay two identities.
    expect((await storedEntity(harness.driver, loaderId))?.validUntil).toBeNull();
    expect((await storedEntity(harness.driver, batchId))?.validUntil).toBeNull();

    expect(await countAutoMergedEntities(harness.driver)).toBe(1);
  }, 120_000);

  it('leaves the evidence a person reversing the merge would need', async () => {
    const decisions = findEntityMergeDecisionsForEntity(db, spacedId);

    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      tier: 'tier0',
      judge: null,
      reasons: ['both names squash to ledgercache'],
      cascadeVersion: 'cascade-1',
    });
    expect(decisions[0]?.signals[0]).toMatchObject({ nameFormRelation: 'squash' });
    expect(JSON.stringify(decisions[0])).not.toContain('confidence');
  }, 60_000);

  it('is a no-op on a second run, because the duplicate spelling is gone', async () => {
    const second = await mergeAutoOperation().run(contextFor());

    expect(second.status).toBe('noop');
    expect(second.itemsProcessed).toBe(0);
    expect(second.itemsAffected).toBe(0);
  }, 120_000);

  it('merges an identity that already answers to another current name as an alias', async () => {
    const holderId = await seedEntity('Harbor Index', 'tool');
    const ownerId = await seedEntity('hbr', 'tool');
    await addEntityAliases(harness.driver, [
      { id: holderId, nameNorm: 'harbor index', aliases: ['hbr'] },
    ]);

    const outcome = await mergeAutoOperation().run(contextFor());

    expect(outcome.itemsAffected).toBe(1);
    expect(await wasEntityMergeApplied(harness.driver, holderId, ownerId)).toBe(true);
    expect(findEntityMergeDecisionsForEntity(db, ownerId)[0]?.reasons).toEqual([
      "one already answers to the other's name, as the alias hbr",
    ]);
  }, 120_000);

  it('does nothing with AION_AUTO_MERGE off, leaving the duplicate spelling in place', async () => {
    const dottedId = await seedEntity('stripe.webhook', 'tool');
    const spaceyId = await seedEntity('stripe webhook', 'topic');
    const disabled: Config = {
      ...DEFAULTS,
      maintenance: { ...DEFAULTS.maintenance, autoMerge: false },
    };

    const outcome = await mergeAutoOperation().run(contextFor(disabled));

    expect(outcome).toEqual({
      status: 'noop',
      itemsProcessed: 0,
      itemsAffected: 0,
      detail: 'auto-merge disabled by AION_AUTO_MERGE; nothing swept',
    });
    expect(await wasEntityMergeApplied(harness.driver, dottedId, spaceyId)).toBe(false);
    expect((await storedEntity(harness.driver, spaceyId))?.validUntil).toBeNull();
  }, 120_000);
});
