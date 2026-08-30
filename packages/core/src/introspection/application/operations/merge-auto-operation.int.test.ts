import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { mergeAutoOperation } from './merge-auto-operation.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import type { Config } from '../../../infrastructure/config/schema.js';
import {
  mergeEntities,
  type EntityMergeInput,
} from '../../../infrastructure/graph/entity-queries.js';
import {
  countAutoMergedEntities,
  wasEntityMergeApplied,
} from '../../../infrastructure/graph/merge-shadow-queries.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import { supersessionEdge } from '../../../infrastructure/graph/test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger } from '../../../infrastructure/logging/logger.js';
import { refusingProvider } from '../../../infrastructure/providers/test-support/refusing-provider.fixture.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import {
  getEntityMergeProposal,
  recordEntityMergeProposal,
} from '../../../infrastructure/sqlite/entity-merge-proposals.js';
import type { OperationContext } from '../../domain/operation.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';

const EMBED_DIMENSION = 8;
const NOW = new Date('2026-08-29T13:00:00.000Z');

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;

async function seedEntity(name: string, type: string): Promise<string> {
  const entity: EntityMergeInput = {
    name,
    nameNorm: name.toLowerCase(),
    type,
    text: `${name} (${type})`,
    sourceEpisodeId: 'seed-episode',
    extractionMethod: 'test',
    confidence: 0.8,
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
  it('merges the exact-name pair, leaves the fuzzy pair queued, and counts the merge', async () => {
    const cacheToolId = await seedEntity('Ledger Cache', 'tool');
    const cacheConceptId = await seedEntity('Ledger Cache', 'concept');
    const loaderId = await seedEntity('Fenwick Loader', 'service');
    const batchId = await seedEntity('Fenwick Batch', 'concept');

    const exactId = recordEntityMergeProposal(db, {
      subject: { id: cacheToolId, name: 'Ledger Cache', type: 'tool' },
      candidate: { id: cacheConceptId, name: 'Ledger Cache', type: 'concept' },
      similarity: 0.95,
      episodeId: 'ep-cache',
    });
    const fuzzyId = recordEntityMergeProposal(db, {
      subject: { id: loaderId, name: 'Fenwick Loader', type: 'service' },
      candidate: { id: batchId, name: 'Fenwick Batch', type: 'concept' },
      similarity: 0.87,
      episodeId: 'ep-fenwick',
    });

    const outcome = await mergeAutoOperation().run(contextFor());

    expect(outcome.status).toBe('applied');
    expect(outcome.itemsProcessed).toBe(2);
    expect(outcome.itemsAffected).toBe(1);
    expect(outcome.detail).toBe(
      '1 exact-name proposal(s) auto-merged, 0 cleared, 1 left queued for review',
    );

    expect(await wasEntityMergeApplied(harness.driver, cacheToolId, cacheConceptId)).toBe(true);
    // Whichever side the merge kept canonical, the other one carries the SUPERSEDES edge.
    const edge =
      (await supersessionEdge(harness.driver, cacheToolId)) ??
      (await supersessionEdge(harness.driver, cacheConceptId));
    expect(edge?.signals).toEqual(['entity_merge']);
    expect(edge?.provenance).toEqual(['auto_merge']);

    expect(getEntityMergeProposal(db, exactId)?.resolvedAt).toEqual(expect.any(String));
    expect(getEntityMergeProposal(db, fuzzyId)?.resolvedAt).toBeNull();

    expect(await countAutoMergedEntities(harness.driver)).toBe(1);
  }, 120_000);

  it('is a no-op on a second run once the exact set is empty, and never touches the fuzzy pair', async () => {
    const second = await mergeAutoOperation().run(contextFor());

    expect(second.status).toBe('noop');
    expect(second.itemsAffected).toBe(0);
    // The fuzzy pair from the previous test is still open and still the only thing seen.
    expect(second.itemsProcessed).toBe(1);
  }, 120_000);

  it('does nothing with AION_AUTO_MERGE off, leaving the proposal open and unmerged', async () => {
    const toolId = await seedEntity('Harbor Index', 'tool');
    const conceptId = await seedEntity('Harbor Index', 'concept');
    const proposalId = recordEntityMergeProposal(db, {
      subject: { id: toolId, name: 'Harbor Index', type: 'tool' },
      candidate: { id: conceptId, name: 'Harbor Index', type: 'concept' },
      similarity: 0.97,
      episodeId: 'ep-harbor',
    });
    const disabled: Config = {
      ...DEFAULTS,
      maintenance: { ...DEFAULTS.maintenance, autoMerge: false },
    };

    const outcome = await mergeAutoOperation().run(contextFor(disabled));

    expect(outcome).toEqual({
      status: 'noop',
      itemsProcessed: 0,
      itemsAffected: 0,
      detail: 'auto-merge disabled by AION_AUTO_MERGE; no proposals examined',
    });
    expect(await wasEntityMergeApplied(harness.driver, toolId, conceptId)).toBe(false);
    expect(getEntityMergeProposal(db, proposalId)?.resolvedAt).toBeNull();
  }, 120_000);
});
