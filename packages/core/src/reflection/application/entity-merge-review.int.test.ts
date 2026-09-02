import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  applyEntityMergeProposal,
  dismissEntityMergeProposal,
  ENTITY_MERGE_APPLY_METHOD,
} from './entity-merge-review.js';
import { ProposalNotFoundError } from './proposals.js';
import { upsertEdge } from '../../infrastructure/graph/edges.js';
import { redirectAndAbsorb } from '../../infrastructure/graph/entity-merge-queries.js';
import { mergeEntities, type EntityMergeInput } from '../../infrastructure/graph/entity-queries.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import {
  storedEntity,
  supersessionEdge,
} from '../../infrastructure/graph/test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger, type Logger } from '../../infrastructure/logging/logger.js';
import { openSqliteHandle, type SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  entityMergeDecisionKey,
  getEntityMergeDecision,
  getEntityMergeDecisionByKey,
} from '../../infrastructure/sqlite/entity-merge-decisions.js';
import {
  getEntityMergeProposal,
  recordEntityMergeProposal,
} from '../../infrastructure/sqlite/entity-merge-proposals.js';
import { getLedgerEntry } from '../../infrastructure/sqlite/ops-ledger.js';
import { ENTITY_CASCADE_VERSION, entityMergeLedgerKey } from '../domain/entity-merge.js';

/**
 * The path a cross-type merge proposal takes once a person agrees the pair is one identity.
 * Detection never applies these rows on its own (`entity-merge-proposals.ts`), so this is the
 * only place a proposal turns into a graph write, and the only case this file has to cover is
 * whether that write, and its refusals, behave.
 */

const EMBED_DIMENSION = 8;
const NOW = new Date('2026-08-29T12:00:00.000Z');

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let logger: Logger;

async function seedEntity(name: string, type: string): Promise<string> {
  const entity: EntityMergeInput = {
    name,
    nameNorm: name.toLowerCase(),
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

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-entity-merge-review-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'error' });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('applying an entity-merge proposal', () => {
  it('merges the pair, redirects the absorbed side edges, and stamps the review as its own provenance', async () => {
    const ingestId = await seedEntity('Zephyr Ingest', 'service');
    const queueId = await seedEntity('Zephyr Queue', 'concept');
    const downstreamId = await seedEntity('Downstream Consumer', 'service');
    // Both sides carry an edge to the same third node, so whichever one the selection rule
    // absorbs, exactly one redirect happens regardless of which side wins.
    await upsertEdge(harness.driver, {
      type: 'RELATED_TO',
      sourceId: ingestId,
      targetId: downstreamId,
      strength: 0.6,
      confidence: 0.8,
      signals: ['test'],
      provenance: ['test'],
      now: NOW,
    });
    await upsertEdge(harness.driver, {
      type: 'RELATED_TO',
      sourceId: queueId,
      targetId: downstreamId,
      strength: 0.6,
      confidence: 0.8,
      signals: ['test'],
      provenance: ['test'],
      now: NOW,
    });
    const proposalId = recordEntityMergeProposal(db, {
      subject: { id: ingestId, name: 'Zephyr Ingest', type: 'service' },
      candidate: { id: queueId, name: 'Zephyr Queue', type: 'concept' },
      similarity: 0.91,
      similaritySource: 'name_cosine',
      episodeId: 'ep-zephyr',
    });

    const result = await applyEntityMergeProposal(
      { driver: harness.driver, db, logger },
      { id: proposalId, now: NOW },
    );

    if (result.outcome !== 'applied') {
      throw new Error(`expected the merge to apply, got ${result.outcome}`);
    }
    expect([ingestId, queueId]).toContain(result.canonical.id);
    expect([ingestId, queueId]).toContain(result.absorbed.id);
    expect(result.canonical.id).not.toBe(result.absorbed.id);
    expect(result.edgesRedirected).toBe(1);

    const absorbed = await storedEntity(harness.driver, result.absorbed.id);
    expect(absorbed?.validUntil).not.toBeNull();
    const edge = await supersessionEdge(harness.driver, result.absorbed.id);
    expect(edge?.sourceId).toBe(result.canonical.id);
    expect(edge?.signals).toEqual(['entity_merge']);
    expect(edge?.provenance).toEqual([ENTITY_MERGE_APPLY_METHOD]);

    const canonical = await storedEntity(harness.driver, result.canonical.id);
    expect(canonical?.aliases).toContain(result.absorbed.name);

    expect(getEntityMergeProposal(db, proposalId)?.resolvedAt).toEqual(expect.any(String));
    const key = entityMergeLedgerKey(ENTITY_CASCADE_VERSION, result.canonical.id, [
      result.absorbed.id,
    ]);
    expect(getLedgerEntry(db, key)).toBeDefined();

    // The merge a person made is the one a reversal most wants to cite, so the record and the
    // key the graph carries to reach it are both part of the apply, not of the tiers only.
    const decision = getEntityMergeDecision(db, result.decisionId);
    expect(decision?.tier).toBe('human');
    expect(decision?.canonicalId).toBe(result.canonical.id);
    expect(decision?.memberIds).toEqual([result.absorbed.id]);
    expect(decision?.judge).toBeNull();
    expect(
      getEntityMergeDecisionByKey(
        db,
        entityMergeDecisionKey(result.canonical.id, [result.absorbed.id], ENTITY_CASCADE_VERSION),
      )?.id,
    ).toBe(result.decisionId);
  }, 120_000);

  it('returns already_resolved on a second apply, and writes nothing further', async () => {
    const loaderId = await seedEntity('Fenwick Loader', 'service');
    const batchId = await seedEntity('Fenwick Batch', 'concept');
    const proposalId = recordEntityMergeProposal(db, {
      subject: { id: loaderId, name: 'Fenwick Loader', type: 'service' },
      candidate: { id: batchId, name: 'Fenwick Batch', type: 'concept' },
      similarity: 0.88,
      similaritySource: 'name_cosine',
      episodeId: 'ep-fenwick',
    });
    const first = await applyEntityMergeProposal(
      { driver: harness.driver, db, logger },
      { id: proposalId, now: NOW },
    );
    if (first.outcome !== 'applied') {
      throw new Error(`expected the first apply to merge, got ${first.outcome}`);
    }
    const canonicalBefore = await storedEntity(harness.driver, first.canonical.id);

    const second = await applyEntityMergeProposal(
      { driver: harness.driver, db, logger },
      { id: proposalId, now: NOW },
    );

    expect(second).toEqual({
      outcome: 'already_resolved',
      id: proposalId,
      resolvedAt: expect.any(String),
    });
    const canonicalAfter = await storedEntity(harness.driver, first.canonical.id);
    expect(canonicalAfter?.aliases).toEqual(canonicalBefore?.aliases);
  }, 120_000);

  /**
   * The pair a proposal judged is not fixed in place: a later, unrelated merge can absorb one
   * side first. Applying the stale row would either resurrect a closed node or merge the wrong
   * pair, so it refuses and resolves the row instead of guessing.
   */
  it('returns stale and resolves the row when one side was already merged away', async () => {
    const cacheId = await seedEntity('Harrow Cache', 'tool');
    const storeId = await seedEntity('Harrow Store', 'concept');
    const otherCanonicalId = await seedEntity('Unrelated Canonical', 'tool');
    await redirectAndAbsorb(harness.driver, {
      canonicalId: otherCanonicalId,
      canonicalNameNorm: 'unrelated canonical',
      mergedIds: [storeId],
      aliases: ['Harrow Store'],
      accessCount: 0,
      now: NOW,
    });
    const proposalId = recordEntityMergeProposal(db, {
      subject: { id: cacheId, name: 'Harrow Cache', type: 'tool' },
      candidate: { id: storeId, name: 'Harrow Store', type: 'concept' },
      similarity: 0.87,
      similaritySource: 'name_cosine',
      episodeId: 'ep-harrow',
    });
    const proposal = getEntityMergeProposal(db, proposalId);
    if (proposal === undefined) {
      throw new Error('proposal did not record');
    }
    const expectedSide = proposal.leftId === storeId ? 'left' : 'right';

    const result = await applyEntityMergeProposal(
      { driver: harness.driver, db, logger },
      { id: proposalId, now: NOW },
    );

    expect(result).toEqual({ outcome: 'stale', id: proposalId, missingSide: expectedSide });
    expect(getEntityMergeProposal(db, proposalId)?.resolvedAt).toEqual(expect.any(String));
  }, 120_000);

  it('throws for an id in neither queue', async () => {
    await expect(
      applyEntityMergeProposal(
        { driver: harness.driver, db, logger },
        { id: 'no-such-merge-proposal', now: NOW },
      ),
    ).rejects.toBeInstanceOf(ProposalNotFoundError);
  }, 120_000);
});

describe('dismissing an entity-merge proposal', () => {
  it('resolves the row and leaves the graph untouched', async () => {
    const workerId = await seedEntity('Solstice Worker', 'service');
    const runnerId = await seedEntity('Solstice Runner', 'concept');
    const proposalId = recordEntityMergeProposal(db, {
      subject: { id: workerId, name: 'Solstice Worker', type: 'service' },
      candidate: { id: runnerId, name: 'Solstice Runner', type: 'concept' },
      similarity: 0.86,
      similaritySource: 'name_cosine',
      episodeId: 'ep-solstice',
    });
    const workerBefore = await storedEntity(harness.driver, workerId);
    const runnerBefore = await storedEntity(harness.driver, runnerId);

    const result = dismissEntityMergeProposal(db, proposalId, NOW);

    expect(result.dismissed).toBe(true);
    if (!result.dismissed) {
      throw new Error('expected the dismiss to resolve the row');
    }
    expect([result.left.id, result.right.id].sort()).toEqual([runnerId, workerId].sort());
    expect(getEntityMergeProposal(db, proposalId)?.resolvedAt).toEqual(expect.any(String));

    const workerAfter = await storedEntity(harness.driver, workerId);
    const runnerAfter = await storedEntity(harness.driver, runnerId);
    expect(workerAfter).toEqual(workerBefore);
    expect(runnerAfter).toEqual(runnerBefore);
  }, 120_000);

  it('throws for an id in neither queue', () => {
    expect(() => dismissEntityMergeProposal(db, 'no-such-merge-proposal', NOW)).toThrow(
      ProposalNotFoundError,
    );
  });
});
