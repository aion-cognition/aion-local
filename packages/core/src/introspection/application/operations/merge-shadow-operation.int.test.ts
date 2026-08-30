import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { mergeShadowOperation } from './merge-shadow-operation.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import type { Config } from '../../../infrastructure/config/schema.js';
import {
  mergeEntities,
  type EntityMergeInput,
} from '../../../infrastructure/graph/entity-queries.js';
import { wasEntityMergeApplied } from '../../../infrastructure/graph/merge-shadow-queries.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import {
  countNodes,
  countRelationships,
} from '../../../infrastructure/graph/test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger } from '../../../infrastructure/logging/logger.js';
import { refusingProvider } from '../../../infrastructure/providers/test-support/refusing-provider.fixture.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import {
  listEntityMergeProposals,
  recordEntityMergeProposal,
} from '../../../infrastructure/sqlite/entity-merge-proposals.js';
import { getLedgerEntry } from '../../../infrastructure/sqlite/ops-ledger.js';
import { applyEntityMergeProposal } from '../../../reflection/application/entity-merge-review.js';
import {
  mergeShadowLedgerKey,
  readMergeShadowVerdict,
  summarizeMergeShadowAgreement,
  type MergeShadowResolvedJudgment,
} from '../../domain/merge-shadow.js';
import type { OperationContext } from '../../domain/operation.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';

/**
 * The op reads proposals and the ops ledger only; a live graph is here so the run can be
 * checked against it afterward, not because the op itself touches one.
 */

const EMBED_DIMENSION = 8;
const NOW = new Date('2026-08-29T12:00:00.000Z');

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;

const config: Config = DEFAULTS;

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

function contextFor(): OperationContext {
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
  dataDir = mkdtempSync(join(tmpdir(), 'aion-merge-shadow-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('mergeShadowOperation against a live graph', () => {
  it('judges an exact-name pair and a differently-named pair, and writes nothing to the graph', async () => {
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
    const differentId = recordEntityMergeProposal(db, {
      subject: { id: loaderId, name: 'Fenwick Loader', type: 'service' },
      candidate: { id: batchId, name: 'Fenwick Batch', type: 'concept' },
      similarity: 0.87,
      episodeId: 'ep-fenwick',
    });

    const nodesBefore = await countNodes(harness.driver);
    const relationshipsBefore = await countRelationships(harness.driver);

    const outcome = await mergeShadowOperation().run(contextFor());

    expect(outcome.status).toBe('applied');
    expect(outcome.itemsAffected).toBe(2);

    const exactEntry = getLedgerEntry(db, mergeShadowLedgerKey(exactId));
    const differentEntry = getLedgerEntry(db, mergeShadowLedgerKey(differentId));
    expect(readMergeShadowVerdict(exactEntry?.summary)).toBe('would_apply');
    expect(readMergeShadowVerdict(differentEntry?.summary)).toBe('would_queue');

    expect(await countNodes(harness.driver)).toBe(nodesBefore);
    expect(await countRelationships(harness.driver)).toBe(relationshipsBefore);
    expect(await wasEntityMergeApplied(harness.driver, cacheToolId, cacheConceptId)).toBe(false);
    expect(listEntityMergeProposals(db).every((proposal) => proposal.resolvedAt === null)).toBe(
      true,
    );
  }, 120_000);

  it('leaves an already-judged proposal alone on a second run', async () => {
    const firstId = await seedEntity('Solstice Worker', 'service');
    const secondId = await seedEntity('Solstice Worker', 'concept');
    recordEntityMergeProposal(db, {
      subject: { id: firstId, name: 'Solstice Worker', type: 'service' },
      candidate: { id: secondId, name: 'Solstice Worker', type: 'concept' },
      similarity: 0.93,
      episodeId: 'ep-solstice',
    });

    await mergeShadowOperation().run(contextFor());
    const second = await mergeShadowOperation().run(contextFor());

    expect(second.status).toBe('noop');
    expect(second.itemsAffected).toBe(0);
  }, 120_000);

  it('agrees with a real apply of the exact-name pair once the ledger and the graph are compared', async () => {
    const toolId = await seedEntity('Harbor Index', 'tool');
    const conceptId = await seedEntity('Harbor Index', 'concept');
    const proposalId = recordEntityMergeProposal(db, {
      subject: { id: toolId, name: 'Harbor Index', type: 'tool' },
      candidate: { id: conceptId, name: 'Harbor Index', type: 'concept' },
      similarity: 0.97,
      episodeId: 'ep-harbor',
    });

    await mergeShadowOperation().run(contextFor());
    const applied = await applyEntityMergeProposal(harness.driver, db, {
      id: proposalId,
      now: NOW,
    });
    if (applied.outcome !== 'applied') {
      throw new Error(`expected the merge to apply, got ${applied.outcome}`);
    }

    const entry = getLedgerEntry(db, mergeShadowLedgerKey(proposalId));
    const verdict = readMergeShadowVerdict(entry?.summary);
    if (verdict === undefined) {
      throw new Error('expected the shadow to have recorded a verdict before the apply');
    }
    const actuallyMerged = await wasEntityMergeApplied(harness.driver, toolId, conceptId);
    const judgment: MergeShadowResolvedJudgment = {
      proposalId,
      leftName: 'Harbor Index',
      leftType: 'tool',
      rightName: 'Harbor Index',
      rightType: 'concept',
      verdict,
      actuallyMerged,
    };

    const agreement = summarizeMergeShadowAgreement([judgment]);

    expect(actuallyMerged).toBe(true);
    expect(agreement).toEqual({ total: 1, agreeing: 1, disagreements: [] });
  }, 120_000);
});
