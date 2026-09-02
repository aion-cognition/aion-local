import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Dedup's harder half: what a merge must survive concurrently, the embedding model's
 * degenerate classes, and the pairs a judge splits on rather than merges.
 * The merge itself and what it has to stay merged against are `entity-dedup.int.test.ts`;
 * this file carries its own harness because an integration file owns its own container.
 */
import { EntityDedupStage } from './entity-dedup.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import { writeStampedNode } from '../../../infrastructure/graph/bitemporal.js';
import { redirectAndAbsorb } from '../../../infrastructure/graph/entity-merge-queries.js';
import {
  linkEntityMentions,
  mergeEntities,
  writeEntityVectors,
  type EntityMergeInput,
} from '../../../infrastructure/graph/entity-queries.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import {
  participatingEpisodeIds,
  storedEntity,
  supersedingNodeIds,
} from '../../../infrastructure/graph/test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger } from '../../../infrastructure/logging/logger.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import { listEntityMergeProposals } from '../../../infrastructure/sqlite/entity-merge-proposals.js';
import type { StageContext } from '../../domain/stage.js';
import { PIPELINE_VERSION } from '../../domain/version.js';
import {
  judgedNames,
  refusingEntityJudge,
  scriptedEntityJudge,
  unreachableEntityJudge,
  type ScriptedEntityJudge,
} from '../entity-merge-judge.fixture.js';

/**
 * The similarity search, mention-count aggregation, edge redirection and `supersede` close
 * all run genuine Cypher against a live server here. Vectors are hand-built rather than
 * embedded by a real model: a fixed, known cosine keeps the merge/no-merge boundary
 * deterministic, and the real embedding path is already proven by `entities.int.test.ts`. The
 * one exception is the degenerate-embedding case at the bottom, which only reproduces against
 * the real model.
 */

const DIMENSION = DEFAULTS.models.embedDimension;
const NOW = new Date('2026-08-28T12:00:00.000Z');

function unitVector(index: number): number[] {
  const vector = new Array<number>(DIMENSION).fill(0);
  vector[index] = 1;
  return vector;
}

/** Cosine against `unitVector(0)` is ~0.998, comfortably over 0.85 and comfortably under 1. */
function nearDuplicateVector(): number[] {
  const vector = unitVector(0);
  vector[1] = 0.05;
  return vector;
}

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let episodeId: string;

async function seedEntity(
  input: Omit<EntityMergeInput, 'occurredAt'>,
  vector: readonly number[],
): Promise<string> {
  const [merged] = await mergeEntities(harness.driver, [{ ...input, occurredAt: NOW }], NOW);
  if (merged === undefined) {
    throw new Error(`failed to seed entity ${input.name}`);
  }
  await writeEntityVectors(harness.driver, [{ id: merged.id, nameVector: vector }]);
  return merged.id;
}

async function seedEpisode(id: string): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Episode',
    id,
    now: NOW,
    properties: { text: 'text', session_id: 'session-1' },
  });
}

/**
 * Tier 3 decides every nominated pair, so a run needs a judge. Each case scripts its own: this
 * database accumulates every entity the file seeds, and a blanket answer would say more about
 * the script than about the predicate under test.
 */
function context(judge: ScriptedEntityJudge = refusingEntityJudge()): StageContext {
  return {
    driver: harness.driver,
    db,
    provider: { embed: async () => [], generate: judge.generate },
    episodeId,
    episode: { id: episodeId, sessionId: 'session-1', text: '', turns: [] },
    logger: openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' }),
    now: NOW,
    occurredAt: NOW,
    pipelineVersion: PIPELINE_VERSION,
  };
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-entity-dedup-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: DIMENSION });
}, 120_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('merge atomicity', () => {
  const atomicEpisodeId = 'live-episode-atomic';
  let survivorId: string;
  let doomedId: string;

  beforeAll(async () => {
    await seedEpisode(atomicEpisodeId);
    survivorId = await seedEntity(
      {
        name: 'Valkey',
        nameNorm: 'valkey',
        type: 'tool',
        text: 'Valkey (tool): the cache',
        sourceEpisodeId: atomicEpisodeId,
        extractionMethod: 'test',
        confidence: 0.8,
      },
      unitVector(0),
    );
    doomedId = await seedEntity(
      {
        name: 'Valkey Server',
        nameNorm: 'valkey server',
        type: 'tool',
        text: 'Valkey Server (tool): the same cache',
        sourceEpisodeId: atomicEpisodeId,
        extractionMethod: 'test',
        confidence: 0.8,
      },
      nearDuplicateVector(),
    );
    await linkEntityMentions(harness.driver, {
      episodeId: atomicEpisodeId,
      entityIds: [survivorId, doomedId],
      now: NOW,
      confidence: 0.8,
      provenance: ['test'],
    });
  }, 120_000);

  it('closes each merged node in the transaction that moved its edges', async () => {
    const result = await redirectAndAbsorb(harness.driver, {
      canonicalId: survivorId,
      canonicalNameNorm: 'valkey',
      mergedIds: [doomedId],
      aliases: ['Valkey Server'],
      accessCount: 2,
      now: NOW,
    });

    expect(result.status).toBe('applied');
    if (result.status !== 'applied') {
      return;
    }
    expect(result.superseded).toEqual([doomedId]);
    expect(result.edgesRedirected).toBeGreaterThan(0);

    // One call, both halves: the closed node has its lineage and the canonical has its edges.
    const doomed = await storedEntity(harness.driver, doomedId);
    expect(doomed?.validUntil).not.toBeNull();
    expect(await supersedingNodeIds(harness.driver, doomedId)).toEqual([survivorId]);
    expect(await participatingEpisodeIds(harness.driver, survivorId)).toContain(atomicEpisodeId);
  }, 60_000);

  it('writes nothing when a member of the group is not a node the graph answers for', async () => {
    const before = await storedEntity(harness.driver, survivorId);

    // The post-lock currency read treats an unknown id as holding no currency, so the group
    // is refused before any redirect work rather than failing partway and rolling back.
    const result = await redirectAndAbsorb(harness.driver, {
      canonicalId: survivorId,
      canonicalNameNorm: 'valkey',
      mergedIds: ['an-id-no-node-answers-to'],
      aliases: ['rolled back'],
      accessCount: 99,
      now: NOW,
    });
    expect(result).toEqual({ status: 'stale', staleIds: ['an-id-no-node-answers-to'] });

    // The alias and salience write shares the transaction with the close, so neither landed.
    const after = await storedEntity(harness.driver, survivorId);
    expect(after?.aliases).toEqual(before?.aliases);
    expect(after?.accessCount).toBe(before?.accessCount);
  }, 60_000);
});

/**
 * The degenerate-embedding case, constructed rather than measured. `nomic-embed-text` returned
 * one constant vector for whole classes of out-of-vocabulary text, so these two names scored
 * 1.0000 against each other and eight distinct emoji entities were closed into one node in the
 * live product. The vectors are hand-built now because the invariant is about what the cascade
 * does with a perfect vector match on two unrelated names, not about which model produces one:
 * `snowflake-arctic-embed2` scores this pair 0.391 and the next model will score it something
 * else again.
 *
 * What has to hold either way: the pair is nominated, no deterministic tier will touch it, and
 * a judge that reads the names is the only thing that could ever merge it.
 */
describe('the degenerate embedding case', () => {
  const degenerateEpisodeId = 'live-episode-degenerate';

  it('nominates two unrelated non-ASCII names with one vector and merges neither', async () => {
    await seedEpisode(degenerateEpisodeId);
    const identical = unitVector(4);
    const subjectId = await seedEntity(
      {
        name: 'Zoë Müller',
        nameNorm: 'zoë müller',
        type: 'person',
        text: 'Zoë Müller (person)',
        sourceEpisodeId: degenerateEpisodeId,
        extractionMethod: 'test',
        confidence: 0.8,
      },
      identical,
    );
    const otherId = await seedEntity(
      {
        name: 'José Álvarez',
        nameNorm: 'josé álvarez',
        type: 'person',
        text: 'José Álvarez (person)',
        sourceEpisodeId: degenerateEpisodeId,
        extractionMethod: 'test',
        confidence: 0.8,
      },
      identical,
    );
    await linkEntityMentions(harness.driver, {
      episodeId: degenerateEpisodeId,
      entityIds: [subjectId],
      now: NOW,
      confidence: 0.8,
      provenance: ['test'],
    });

    episodeId = degenerateEpisodeId;
    const judge = refusingEntityJudge();
    const outcome = await new EntityDedupStage().run(context(judge));

    // The vector put the pair forward, which is the whole point: nomination is cheap and wrong,
    // and every tier after it is what keeps the two identities apart.
    expect(judge.calls.flatMap(judgedNames)).toContain('José Álvarez');
    expect(outcome.counts).toMatchObject({ merges: 0, merge_proposals: 0 });
    expect((await storedEntity(harness.driver, subjectId))?.validUntil).toBeNull();
    expect((await storedEntity(harness.driver, otherId))?.validUntil).toBeNull();
    expect(listEntityMergeProposals(db)).toEqual([]);
  }, 120_000);

  it('will not merge them with no model reachable at all', async () => {
    episodeId = degenerateEpisodeId;

    const outcome = await new EntityDedupStage().run(context(unreachableEntityJudge()));

    expect(outcome.counts).toMatchObject({ merges: 0 });
  }, 120_000);
});

describe('cross-type near-duplicates', () => {
  const crossTypeEpisodeId = 'live-episode-cross-type';

  it('never sees a same-name pair at all, because the second reading is the same identity', async () => {
    await seedEpisode(crossTypeEpisodeId);
    const toolId = await seedEntity(
      {
        name: 'Kubernetes',
        nameNorm: 'kubernetes',
        type: 'tool',
        text: 'Kubernetes (tool): the orchestrator',
        sourceEpisodeId: crossTypeEpisodeId,
        extractionMethod: 'test',
        confidence: 0.8,
      },
      unitVector(0),
    );
    const topicId = await seedEntity(
      {
        name: 'Kubernetes',
        nameNorm: 'kubernetes',
        type: 'topic',
        text: 'Kubernetes (topic): the orchestrator',
        sourceEpisodeId: crossTypeEpisodeId,
        extractionMethod: 'test',
        confidence: 0.8,
      },
      nearDuplicateVector(),
    );
    await linkEntityMentions(harness.driver, {
      episodeId: crossTypeEpisodeId,
      entityIds: [toolId],
      now: NOW,
      confidence: 0.8,
      provenance: ['test'],
    });

    episodeId = crossTypeEpisodeId;
    const outcome = await new EntityDedupStage().run(context());

    // The duplicate factory is gone at the source: there is no second node to propose against.
    expect(topicId).toBe(toolId);
    expect(outcome.counts).toMatchObject({ merges: 0, merge_proposals: 0 });
    expect((await storedEntity(harness.driver, toolId))?.typeCounts).toBe('{"tool":1,"topic":1}');
    expect(
      listEntityMergeProposals(db).filter((proposal) => proposal.episodeId === crossTypeEpisodeId),
    ).toEqual([]);
  }, 120_000);

  it('still proposes a near-duplicate that is genuinely two names typed differently', async () => {
    const twoNameEpisodeId = 'live-episode-cross-type-two-names';
    await seedEpisode(twoNameEpisodeId);
    const engineId = await seedEntity(
      {
        name: 'Kubernetes Engine',
        nameNorm: 'kubernetes engine',
        type: 'topic',
        text: 'Kubernetes Engine (topic): the hosted orchestrator',
        sourceEpisodeId: twoNameEpisodeId,
        extractionMethod: 'test',
        confidence: 0.8,
      },
      nearDuplicateVector(),
    );
    await linkEntityMentions(harness.driver, {
      episodeId: twoNameEpisodeId,
      entityIds: [engineId],
      now: NOW,
      confidence: 0.8,
      provenance: ['test'],
    });

    episodeId = twoNameEpisodeId;
    // The two passes split on this pair alone: one says the hosted product is the orchestrator,
    // the other says a product named after a tool is not that tool. Everything else this
    // database holds is refused outright, so the queue carries the split and nothing more.
    const split = scriptedEntityJudge({
      same: (left, right) => [left, right].every((name) => name.startsWith('Kubernetes')),
      review: () => false,
    });
    const outcome = await new EntityDedupStage().run(context(split));

    expect(outcome.counts).toMatchObject({ merges: 0, merge_proposals: 1 });
    expect((await storedEntity(harness.driver, engineId))?.validUntil).toBeNull();

    const proposals = listEntityMergeProposals(db).filter(
      (proposal) => proposal.episodeId === twoNameEpisodeId,
    );
    expect(proposals).toHaveLength(1);
    expect([proposals[0]?.leftType, proposals[0]?.rightType].sort()).toEqual(['tool', 'topic']);
    expect(proposals[0]?.resolvedAt).toBeNull();
  }, 120_000);
});
