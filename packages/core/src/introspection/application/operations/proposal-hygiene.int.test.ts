import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { proposalHygieneOperation } from './proposal-hygiene.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import { forgetNode, writeStampedNode } from '../../../infrastructure/graph/bitemporal.js';
import {
  mergeEntities,
  type EntityMergeInput,
} from '../../../infrastructure/graph/entity-queries.js';
import { entityMergePairState } from '../../../infrastructure/graph/merge-shadow-queries.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger, type Logger } from '../../../infrastructure/logging/logger.js';
import { refusingProvider } from '../../../infrastructure/providers/test-support/refusing-provider.fixture.js';
import type { Provider } from '../../../infrastructure/providers/types.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import {
  getEntityMergeProposal,
  recordEntityMergeProposal,
} from '../../../infrastructure/sqlite/entity-merge-proposals.js';
import { getLedgerEntry } from '../../../infrastructure/sqlite/ops-ledger.js';
import {
  getSupersessionProposal,
  recordSupersessionProposal,
  reopenSupersessionProposal,
} from '../../../infrastructure/sqlite/supersession-proposals.js';
import { applyEntityMergeProposal } from '../../../reflection/application/entity-merge-review.js';
import type { OperationContext } from '../../domain/operation.js';
import { hygieneLedgerKey } from '../../domain/proposal-hygiene.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';
import { staleMergeLedgerKey } from '../stale-merge-sweep.js';

const EMBED_DIMENSION = 8;
const NOW = new Date('2026-08-29T14:00:00.000Z');
const OLD = new Date(NOW.getTime() - 20 * 86_400_000);
const JUST_OVER_POLLUTED = new Date(NOW.getTime() - 25 * 3_600_000);

let harness: Neo4jHarness;
let db: SqliteHandle;
let logger: Logger;
let dataDir: string;

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-proposal-hygiene-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'error' });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function ctxFor(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    driver: harness.driver,
    db,
    config: DEFAULTS,
    logger,
    provider: refusingProvider,
    health: healthFixture(),
    now: NOW,
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function seedEpisode(
  id: string,
  occurredAt: Date,
  turnCount: number,
  toolExecutionCount: number,
): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Episode',
    id,
    occurredAt,
    now: occurredAt,
    properties: {
      text: `episode ${id}`,
      turn_count: turnCount,
      tool_execution_count: toolExecutionCount,
      observation_count: 0,
    },
  });
}

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

/**
 * One live substrate, five structural shapes seeded before a single run: a tool-exhaust
 * episode past the fast horizon, an ordinary one past the residue horizon, one shaped like
 * tool exhaust but newer than its proposal (so it falls through to the ordinary horizon and
 * is not yet past it), a proposal whose episode was forgotten, and an entity-merge pair with
 * one side already superseded. A sixth row inside the residue horizon proves the run leaves
 * what has not aged yet alone.
 */
describe('proposal_hygiene against a live graph', () => {
  it('dismisses exactly the rows past their horizon, with the right class and reason each', async () => {
    await seedEpisode('ep-tool-exhaust', JUST_OVER_POLLUTED, 0, 3);
    const toolExhaustId = recordSupersessionProposal(db, {
      oldId: 'old-tool',
      newId: 'new-tool',
      confidence: 0.6,
      episodeId: 'ep-tool-exhaust',
      createdAt: JUST_OVER_POLLUTED.toISOString(),
    });

    await seedEpisode('ep-ordinary', OLD, 3, 1);
    const ordinaryId = recordSupersessionProposal(db, {
      oldId: 'old-ordinary',
      newId: 'new-ordinary',
      confidence: 0.6,
      episodeId: 'ep-ordinary',
      createdAt: OLD.toISOString(),
    });

    // Shaped like tool exhaust, but the episode's own clock is after the proposal's: a
    // re-detection repointed episode_id to a later detection. Falls through to the ordinary
    // horizon, and twenty hours has not reached it.
    await seedEpisode('ep-repointed', NOW, 0, 2);
    const repointedId = recordSupersessionProposal(db, {
      oldId: 'old-repointed',
      newId: 'new-repointed',
      confidence: 0.6,
      episodeId: 'ep-repointed',
      createdAt: JUST_OVER_POLLUTED.toISOString(),
    });

    const forgottenId = recordSupersessionProposal(db, {
      oldId: 'old-forgotten',
      newId: 'new-forgotten',
      confidence: 0.6,
      episodeId: 'ep-forgotten',
      createdAt: OLD.toISOString(),
    });

    await seedEpisode('ep-stale-side', OLD, 2, 1);
    const legacyId = await seedEntity('Legacy Name', 'concept');
    const supersedingId = await seedEntity('Superseding Name', 'concept');
    const firstMergeId = recordEntityMergeProposal(db, {
      subject: { id: legacyId, name: 'Legacy Name', type: 'concept' },
      candidate: { id: supersedingId, name: 'Legacy Name', type: 'concept' },
      similarity: 1,
      similaritySource: 'name_cosine',
      episodeId: 'ep-stale-side',
    });
    const firstMerge = await applyEntityMergeProposal(
      { driver: harness.driver, db, logger },
      { id: firstMergeId },
    );
    if (firstMerge.outcome !== 'applied') {
      throw new Error('setup expected the exact-name pair to merge');
    }
    const stillCurrentId = await seedEntity('Third Name', 'concept');
    const staleSideId = recordEntityMergeProposal(db, {
      subject: { id: firstMerge.absorbed.id, name: firstMerge.absorbed.name, type: 'concept' },
      candidate: { id: stillCurrentId, name: 'Third Name', type: 'concept' },
      similarity: 0.6,
      similaritySource: 'name_cosine',
      episodeId: 'ep-stale-side',
      createdAt: OLD.toISOString(),
    });

    await seedEpisode('ep-fresh', NOW, 2, 1);
    const freshId = recordSupersessionProposal(db, {
      oldId: 'old-fresh',
      newId: 'new-fresh',
      confidence: 0.6,
      episodeId: 'ep-fresh',
      createdAt: NOW.toISOString(),
    });

    const result = await proposalHygieneOperation().run(ctxFor());

    expect(result.itemsAffected).toBe(4);

    expect(getSupersessionProposal(db, toolExhaustId)?.resolvedAt).toBe(NOW.toISOString());
    const toolExhaustEntry = getLedgerEntry(db, hygieneLedgerKey('supersession', toolExhaustId));
    expect(toolExhaustEntry?.summary).toMatchObject({
      class: 'tooling_exhaust',
      oldId: 'old-tool',
      newId: 'new-tool',
    });

    expect(getSupersessionProposal(db, ordinaryId)?.resolvedAt).toBe(NOW.toISOString());
    expect(getLedgerEntry(db, hygieneLedgerKey('supersession', ordinaryId))?.summary).toMatchObject(
      { class: 'ordinary_residue', reason: 'aged past the residue horizon with no resolution' },
    );

    expect(getSupersessionProposal(db, repointedId)?.resolvedAt).toBeNull();
    expect(getLedgerEntry(db, hygieneLedgerKey('supersession', repointedId))).toBeUndefined();

    expect(getSupersessionProposal(db, forgottenId)?.resolvedAt).toBe(NOW.toISOString());
    expect(
      getLedgerEntry(db, hygieneLedgerKey('supersession', forgottenId))?.summary,
    ).toMatchObject({ class: 'ordinary_residue' });

    // The sweep took this one, not the horizon pass: an absorbed side means there is nothing
    // left to merge, whatever the row's age.
    expect(getEntityMergeProposal(db, staleSideId)?.resolvedAt).toBe(NOW.toISOString());
    expect(getLedgerEntry(db, staleMergeLedgerKey(staleSideId))?.summary).toMatchObject({
      reason: 'a side of this pair lost currency, so there is nothing left to merge',
      goneSides: [firstMerge.absorbed.id],
    });
    expect(getLedgerEntry(db, hygieneLedgerKey('entity_merge', staleSideId))).toBeUndefined();

    expect(getSupersessionProposal(db, freshId)?.resolvedAt).toBeNull();

    const second = await proposalHygieneOperation().run(ctxFor());
    expect(second.itemsAffected).toBe(0);
  }, 300_000);

  it('judges a fuzzy pair with both sides current, and dismisses on the verdict', async () => {
    await seedEpisode('ep-fuzzy', OLD, 2, 1);
    const leftId = await seedEntity('Ledger Cache', 'tool');
    const rightId = await seedEntity('Ledger Store', 'concept');
    const fuzzyId = recordEntityMergeProposal(db, {
      subject: { id: leftId, name: 'Ledger Cache', type: 'tool' },
      candidate: { id: rightId, name: 'Ledger Store', type: 'concept' },
      similarity: 0.6,
      similaritySource: 'name_cosine',
      episodeId: 'ep-fuzzy',
      createdAt: OLD.toISOString(),
    });
    expect((await entityMergePairState(harness.driver, leftId, rightId)).bothCurrent).toBe(true);

    let calls = 0;
    const provider: Provider = {
      embed: () => Promise.reject(new Error('proposal hygiene must never embed')),
      generate: () => {
        calls += 1;
        return Promise.resolve({ verdict: 'same', reason: 'both name the caching layer' });
      },
    };

    const result = await proposalHygieneOperation().run(ctxFor({ provider }));

    expect(calls).toBe(1);
    expect(result.itemsAffected).toBe(1);
    expect(getEntityMergeProposal(db, fuzzyId)?.resolvedAt).toBe(NOW.toISOString());
    expect(getLedgerEntry(db, hygieneLedgerKey('entity_merge', fuzzyId))?.summary).toMatchObject({
      verdict: 'same',
    });
    // The verdict never merges the pair: exact-fold equality stays the only auto-apply.
    expect((await entityMergePairState(harness.driver, leftId, rightId)).merged).toBe(false);
  }, 300_000);

  it('reopens a dismissed row, and the next run reclassifies it fresh rather than skipping it', async () => {
    await seedEpisode('ep-reopen', OLD, 2, 1);
    const id = recordSupersessionProposal(db, {
      oldId: 'old-reopen',
      newId: 'new-reopen',
      confidence: 0.6,
      episodeId: 'ep-reopen',
      createdAt: OLD.toISOString(),
    });

    const first = await proposalHygieneOperation().run(ctxFor());
    expect(first.itemsAffected).toBeGreaterThanOrEqual(1);
    expect(getSupersessionProposal(db, id)?.resolvedAt).not.toBeNull();
    const firstStamp = getLedgerEntry(db, hygieneLedgerKey('supersession', id));
    expect(firstStamp).toBeDefined();

    expect(reopenSupersessionProposal(db, id)).toBe(true);
    expect(getSupersessionProposal(db, id)?.resolvedAt).toBeNull();

    const later = new Date(NOW.getTime() + 1_000);
    const second = await proposalHygieneOperation().run(ctxFor({ now: later }));

    expect(getSupersessionProposal(db, id)?.resolvedAt).toBe(later.toISOString());
    const secondStamp = getLedgerEntry(db, hygieneLedgerKey('supersession', id));
    expect(secondStamp?.appliedAt).not.toBe(firstStamp?.appliedAt);
    expect(second.itemsAffected).toBeGreaterThanOrEqual(1);
  }, 300_000);

  it('never touches a row whose episode was forgotten between detection and this run', async () => {
    await seedEpisode('ep-to-forget', OLD, 2, 1);
    await forgetNode(harness.driver, { id: 'ep-to-forget', now: NOW });
    const id = recordSupersessionProposal(db, {
      oldId: 'old-vanished',
      newId: 'new-vanished',
      confidence: 0.6,
      episodeId: 'ep-to-forget',
      createdAt: OLD.toISOString(),
    });

    const result = await proposalHygieneOperation().run(ctxFor());

    // Unreadable, not tool exhaust: dismissed on the ordinary horizon since it is old enough.
    expect(result.itemsAffected).toBeGreaterThanOrEqual(1);
    expect(getSupersessionProposal(db, id)?.resolvedAt).toBe(NOW.toISOString());
    expect(getLedgerEntry(db, hygieneLedgerKey('supersession', id))?.summary).toMatchObject({
      class: 'ordinary_residue',
    });
  }, 300_000);

  it('resolves a merge proposal the moment a side is absorbed, without waiting a horizon', async () => {
    await seedEpisode('ep-sweep-fresh', NOW, 2, 1);
    // Two names, not one twice: `mergeEntities` upserts on the folded name, so seeding one
    // name twice returns one node, and a merge of a node into itself is a merge the writer
    // refuses. The sweep only needs a side that is genuinely gone.
    const absorbedId = await seedEntity('Sweep Legacy', 'topic');
    const canonicalId = await seedEntity('Sweep Legacy Successor', 'topic');
    const setupId = recordEntityMergeProposal(db, {
      subject: { id: absorbedId, name: 'Sweep Legacy', type: 'topic' },
      candidate: { id: canonicalId, name: 'Sweep Legacy Successor', type: 'topic' },
      similarity: 1,
      similaritySource: 'name_cosine',
      episodeId: 'ep-sweep-fresh',
    });
    const applied = await applyEntityMergeProposal(
      { driver: harness.driver, db, logger },
      { id: setupId },
    );
    if (applied.outcome !== 'applied') {
      throw new Error(`setup expected the pair to merge, got ${applied.outcome}`);
    }
    const partnerId = await seedEntity('Sweep Partner', 'topic');
    // Created now, so no horizon has passed and no judge call is owed.
    const freshStaleId = recordEntityMergeProposal(db, {
      subject: { id: applied.absorbed.id, name: applied.absorbed.name, type: 'topic' },
      candidate: { id: partnerId, name: 'Sweep Partner', type: 'topic' },
      similarity: 0.6,
      similaritySource: 'name_cosine',
      episodeId: 'ep-sweep-fresh',
      createdAt: NOW.toISOString(),
    });

    await proposalHygieneOperation().run(ctxFor());

    expect(getEntityMergeProposal(db, freshStaleId)?.resolvedAt).toBe(NOW.toISOString());
    expect(getLedgerEntry(db, staleMergeLedgerKey(freshStaleId))?.summary).toMatchObject({
      goneSides: [applied.absorbed.id],
    });
  }, 300_000);
});
