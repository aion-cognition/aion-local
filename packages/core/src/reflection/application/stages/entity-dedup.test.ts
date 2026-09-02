import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DedupFakeGraph } from './entity-dedup.fixture.js';
import { EntityDedupStage } from './entity-dedup.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import { ACCESS_COUNT_PROPERTY } from '../../../infrastructure/graph/access-tracking.js';
import { BITEMPORAL_PROPERTIES } from '../../../infrastructure/graph/bitemporal.js';
import { ENTITY_ALIASES_PROPERTY } from '../../../infrastructure/graph/entity-identity-queries.js';
import { MERGE_PROVENANCE_PROPERTY } from '../../../infrastructure/graph/entity-merge-queries.js';
import {
  ENTITY_ALIASES_NORM_PROPERTY,
  ENTITY_MENTION_TYPE,
  ENTITY_NAME_SQUASH_PROPERTY,
  ENTITY_NAME_VECTOR_HASH_PROPERTY,
  ENTITY_PARTICIPATION_TYPE,
  ENTITY_TYPE_COUNTS_PROPERTY,
} from '../../../infrastructure/graph/entity-queries.js';
import type { EpisodeContext } from '../../../infrastructure/graph/episode-context.js';
import { MEMORY_PROPERTIES } from '../../../infrastructure/graph/episodes.js';
import { SUPERSEDES_TYPE } from '../../../infrastructure/graph/relationships.js';
import {
  ENTITY_NAME_NORM_PROPERTY,
  ENTITY_NAME_PROPERTY,
  ENTITY_NAME_VECTOR_PROPERTY,
  STRUCTURAL_PROPERTY,
} from '../../../infrastructure/graph/seed-queries.js';
import { toGraphDateTime } from '../../../infrastructure/graph/values.js';
import { openLogger } from '../../../infrastructure/logging/logger.js';
import { SqliteStore } from '../../../infrastructure/sqlite/database.js';
import { listEntityMergeDecisions } from '../../../infrastructure/sqlite/entity-merge-decisions.js';
import { listEntityMergeProposals } from '../../../infrastructure/sqlite/entity-merge-proposals.js';
import { getLedgerEntry } from '../../../infrastructure/sqlite/ops-ledger.js';
import { ENTITY_CASCADE_VERSION, entityMergeLedgerKey } from '../../domain/entity-merge.js';
import { squashName } from '../../domain/entity-reconciliation.js';
import { foldName } from '../../domain/name-fold.js';
import type { StageContext } from '../../domain/stage.js';
import { PIPELINE_VERSION } from '../../domain/version.js';
import {
  refusingEntityJudge as refusingJudge,
  scriptedEntityJudge as scriptedJudge,
  unreachableEntityJudge as unreachableProvider,
  type ScriptedEntityJudge,
} from '../entity-merge-judge.fixture.js';

/** The shape `runRead` expects back from a statement the fake answers itself. */
const SUMMARY_STUB = {
  counters: { updates: () => ({ nodesCreated: 0, relationshipsCreated: 0, propertiesSet: 0 }) },
};

const EPISODE_ID = 'episode-1';
const SESSION_ID = 'session-1';
const OTHER_EPISODE_ID = 'episode-0';
const THIRD_EPISODE_ID = 'episode-2';
const NOW = new Date('2026-08-28T09:05:00.000Z');
const OLDER = new Date('2026-01-01T00:00:00.000Z');
const NEWER = new Date('2026-06-01T00:00:00.000Z');

let graph: DedupFakeGraph;
let store: SqliteStore;
let dataDir: string;

function episode(): EpisodeContext {
  return { id: EPISODE_ID, sessionId: SESSION_ID, text: '', turns: [] };
}

function context(judge: ScriptedEntityJudge = scriptedJudge()): StageContext {
  return {
    driver: graph.driver,
    db: store.db,
    provider: {
      embed: async () => [],
      generate: judge.generate,
    },
    episodeId: EPISODE_ID,
    episode: episode(),
    logger: openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' }),
    now: NOW,
    occurredAt: NOW,
    pipelineVersion: PIPELINE_VERSION,
  };
}

type EntitySeed = {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly vector: readonly number[];
  readonly txFrom?: Date;
  readonly structural?: boolean;
  readonly accessCount?: number;
  readonly aliases?: readonly string[];
  readonly superseded?: boolean;
  readonly nameVectorHash?: string;
  readonly typeCounts?: string;
  readonly description?: string;
};

function seedEntity(seed: EntitySeed): void {
  const nameNorm = foldName(seed.name);
  graph.seedNode(seed.id, ['Entity', 'Memory', 'AionNode'], {
    [ENTITY_NAME_PROPERTY]: seed.name,
    [ENTITY_NAME_NORM_PROPERTY]: nameNorm,
    [ENTITY_NAME_SQUASH_PROPERTY]: squashName(nameNorm),
    type: seed.type,
    [ENTITY_NAME_VECTOR_PROPERTY]: [...seed.vector],
    [BITEMPORAL_PROPERTIES.txFrom]: seed.txFrom ?? OLDER,
    ...(seed.structural === true ? { [STRUCTURAL_PROPERTY]: true } : {}),
    ...(seed.accessCount === undefined ? {} : { [ACCESS_COUNT_PROPERTY]: seed.accessCount }),
    ...(seed.aliases === undefined
      ? {}
      : {
          [ENTITY_ALIASES_PROPERTY]: [...seed.aliases],
          [ENTITY_ALIASES_NORM_PROPERTY]: seed.aliases.map((alias) => foldName(alias)),
        }),
    ...(seed.superseded === true ? { [BITEMPORAL_PROPERTIES.validUntil]: OLDER } : {}),
    ...(seed.nameVectorHash === undefined
      ? {}
      : { [ENTITY_NAME_VECTOR_HASH_PROPERTY]: seed.nameVectorHash }),
    ...(seed.typeCounts === undefined ? {} : { [ENTITY_TYPE_COUNTS_PROPERTY]: seed.typeCounts }),
    ...(seed.description === undefined ? {} : { [MEMORY_PROPERTIES.text]: seed.description }),
  });
}

function seedEpisode(id: string): void {
  graph.seedNode(id, ['Episode', 'Memory', 'AionNode'], {
    [MEMORY_PROPERTIES.text]: 'text',
    [MEMORY_PROPERTIES.sessionId]: SESSION_ID,
  });
}

function mention(episodeId: string, entityId: string, count = 1): void {
  graph.seedEdge(ENTITY_MENTION_TYPE, episodeId, entityId);
  const edge = graph
    .edgesOfType(ENTITY_MENTION_TYPE)
    .find((candidate) => candidate.sourceId === episodeId && candidate.targetId === entityId);
  if (edge !== undefined) {
    edge.count = count;
  }
  graph.seedEdge(ENTITY_PARTICIPATION_TYPE, entityId, episodeId);
}

beforeEach(() => {
  graph = new DedupFakeGraph();
  seedEpisode(EPISODE_ID);
  dataDir = mkdtempSync(join(tmpdir(), 'aion-entity-dedup-'));
  store = new SqliteStore({ filePath: join(dataDir, 'aion.sqlite') });
});

afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

/** The canonical-to-be seen in two episodes against a duplicate seen in one. */
function seedNearDuplicatePair(): void {
  seedEntity({
    id: 'strong',
    name: 'Aion',
    type: 'project',
    vector: [1, 0],
    txFrom: NEWER,
    accessCount: 3,
  });
  seedEntity({
    id: 'weak',
    name: 'Aion Project',
    type: 'project',
    vector: [9, 4],
    txFrom: OLDER,
    accessCount: 1,
  });
  seedEpisode(OTHER_EPISODE_ID);
  seedEpisode(THIRD_EPISODE_ID);
  mention(EPISODE_ID, 'strong', 3);
  mention(THIRD_EPISODE_ID, 'strong', 1);
  mention(OTHER_EPISODE_ID, 'weak', 1);
}

describe('tier 3, the two-pass judge', () => {
  it('merges a near-duplicate into the more-mentioned identity and closes the loser', async () => {
    seedNearDuplicatePair();

    const outcome = await new EntityDedupStage().run(context());

    expect(outcome.status).toBe('ok');
    expect(outcome.counts).toMatchObject({ merges: 1, merge_proposals: 0, merge_judgments: 1 });

    const strong = graph.nodes.get('strong');
    const weak = graph.nodes.get('weak');
    expect(strong?.properties[BITEMPORAL_PROPERTIES.validUntil]).toBeUndefined();
    expect(weak?.properties[BITEMPORAL_PROPERTIES.validUntil]).toEqual(toGraphDateTime(NOW));
    expect(weak?.properties[BITEMPORAL_PROPERTIES.txUntil]).toEqual(toGraphDateTime(NOW));
    expect(strong?.properties[ENTITY_ALIASES_PROPERTY]).toEqual(['Aion Project']);
    expect(strong?.properties[ACCESS_COUNT_PROPERTY]).toBe(4);

    const supersedes = graph.edgesOfType(SUPERSEDES_TYPE);
    expect(supersedes).toHaveLength(1);
    expect(supersedes[0]).toMatchObject({ sourceId: 'strong', targetId: 'weak' });
  });

  it('records both verdicts, the measured signals and no confidence at all', async () => {
    seedNearDuplicatePair();

    await new EntityDedupStage().run(context());

    const decisions = listEntityMergeDecisions(store.db);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      canonicalId: 'strong',
      memberIds: ['weak'],
      tier: 'tier3',
      cascadeVersion: 'cascade-1',
      judge: {
        detect: { same: true, rationale: 'scripted detection' },
        review: { same: true, rationale: 'scripted review' },
      },
    });
    expect(decisions[0]?.signals).toEqual([
      expect.objectContaining({
        memberId: 'weak',
        nameFormRelation: 'bigram',
        sharedEpisodeCount: 0,
        canonicalMentionCount: 2,
        memberMentionCount: 1,
      }),
    ]);
    expect(JSON.stringify(decisions[0])).not.toContain('confidence');
  });

  it('leaves a pair the second pass argues down as a proposal, merging nothing', async () => {
    seedNearDuplicatePair();

    const outcome = await new EntityDedupStage().run(
      context(scriptedJudge({ review: () => false })),
    );

    expect(outcome.counts).toMatchObject({ merges: 0, merge_proposals: 1, merge_judgments: 1 });
    expect(graph.nodes.get('weak')?.properties[BITEMPORAL_PROPERTIES.validUntil]).toBeUndefined();

    const proposals = listEntityMergeProposals(store.db);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      leftId: 'strong',
      rightId: 'weak',
      episodeId: EPISODE_ID,
      resolvedAt: null,
    });
    expect(listEntityMergeDecisions(store.db)).toHaveLength(0);
  });

  it('queues a unanimous pair instead of merging it when the mode says propose', async () => {
    seedNearDuplicatePair();

    const outcome = await new EntityDedupStage({ mode: 'propose' }).run(context());

    expect(outcome.counts).toMatchObject({ merges: 0, merge_proposals: 1, merge_judgments: 1 });
    expect(graph.nodes.get('weak')?.properties[BITEMPORAL_PROPERTIES.validUntil]).toBeUndefined();
    expect(listEntityMergeProposals(store.db)).toHaveLength(1);
    // The kill switch stops the write, not the reasoning: the pair was still judged twice, and
    // a record of a merge nobody made would claim one.
    expect(listEntityMergeDecisions(store.db)).toHaveLength(0);
  });

  it('keeps the deterministic tier acting when the judge tier is set to propose', async () => {
    seedEntity({ id: 'dashed', name: 'held-out-recall', type: 'topic', vector: [1, 0] });
    seedEntity({
      id: 'scored',
      name: 'held_out_recall',
      type: 'topic',
      vector: [0, 1],
      txFrom: NEWER,
    });
    mention(EPISODE_ID, 'dashed', 1);
    mention(EPISODE_ID, 'scored', 1);

    const outcome = await new EntityDedupStage({ mode: 'propose' }).run(
      context(unreachableProvider()),
    );

    expect(outcome.counts).toMatchObject({ merges: 1, merge_proposals: 0, merge_judgments: 0 });
    expect(listEntityMergeDecisions(store.db)).toHaveLength(1);
  });

  it('proposes nothing when the first pass says the two are different things', async () => {
    seedNearDuplicatePair();

    const outcome = await new EntityDedupStage().run(context(refusingJudge()));

    expect(outcome.counts).toMatchObject({ merges: 0, merge_proposals: 0, merge_judgments: 1 });
    expect(listEntityMergeProposals(store.db)).toHaveLength(0);
  });

  it('treats a second pass that never answered as a split rather than as agreement', async () => {
    seedNearDuplicatePair();
    let call = 0;
    const flaky: ScriptedEntityJudge = {
      calls: [],
      generate: async (): Promise<unknown> => {
        call += 1;
        if (call === 1) {
          return { same: true, rationale: 'first pass' };
        }
        throw new Error('the reviewer never answered');
      },
    };

    const outcome = await new EntityDedupStage().run(context(flaky));

    expect(outcome.counts).toMatchObject({ merges: 0, merge_proposals: 1 });
    expect(graph.nodes.get('weak')?.properties[BITEMPORAL_PROPERTIES.validUntil]).toBeUndefined();
  });

  it('merges a cross-type pair the judge calls one thing, because type was never the question', async () => {
    seedEntity({
      id: 'as-tool',
      name: 'Postgres',
      type: 'tool',
      vector: [1, 0],
      typeCounts: '{"tool":3}',
      description: 'Postgres (tool): the relational store',
    });
    seedEntity({
      id: 'as-topic',
      name: 'PostgreSQL',
      type: 'topic',
      vector: [1, 0],
      txFrom: NEWER,
      typeCounts: '{"topic":1}',
    });
    mention(EPISODE_ID, 'as-tool', 1);

    const judge = scriptedJudge();
    const outcome = await new EntityDedupStage().run(context(judge));

    expect(outcome.counts).toMatchObject({ merges: 1, merge_proposals: 0 });
    expect(graph.nodes.get('as-topic')?.properties[BITEMPORAL_PROPERTIES.validUntil]).toEqual(
      toGraphDateTime(NOW),
    );

    // Both readings and both descriptions reach the judge as evidence, and neither filtered it.
    const prompt = judge.calls[0]?.messages.map((message) => message.content).join('\n') ?? '';
    expect(prompt).toContain('tool 3');
    expect(prompt).toContain('topic 1');
    expect(prompt).toContain('the relational store');
  });

  it('carries on with the vector nominator when the bulk pass cannot run', async () => {
    // Two reflections at once share one projection name, so a bulk pass can be dropped out from
    // under itself. A nominator that cannot run must not take the run's other nominator with it.
    class BrokenBulkGraph extends DedupFakeGraph {
      override async executeQuery(
        cypher: string,
        parameters: Record<string, unknown> = {},
      ): Promise<unknown> {
        if (cypher.includes('SHOW PROCEDURES')) {
          return { records: [{ toObject: () => ({ count: 1 }) }], summary: SUMMARY_STUB };
        }
        if (cypher.includes('gds.')) {
          throw new Error('the projection was dropped by another run');
        }
        return super.executeQuery(cypher, parameters);
      }
    }
    graph = new BrokenBulkGraph();
    seedEpisode(EPISODE_ID);
    seedNearDuplicatePair();

    const outcome = await new EntityDedupStage().run(context());

    expect(outcome.status).toBe('ok');
    expect(outcome.counts).toMatchObject({ merges: 1 });
  });

  it('spends no model call on a pair no nominator put forward', async () => {
    seedEntity({ id: 'a', name: 'Aion', type: 'project', vector: [1, 0] });
    seedEntity({ id: 'b', name: 'Postgres', type: 'project', vector: [1, 1] });
    mention(EPISODE_ID, 'a', 1);

    const judge = scriptedJudge();
    const outcome = await new EntityDedupStage().run(context(judge));

    expect(outcome.counts).toMatchObject({ merges: 0, merge_judgments: 0 });
    expect(judge.calls).toHaveLength(0);
    expect(graph.nodes.get('b')?.properties[BITEMPORAL_PROPERTIES.validUntil]).toBeUndefined();
  });

  it('caps the model calls one run may spend', async () => {
    seedEntity({ id: 'subject', name: 'Aion', type: 'project', vector: [1, 0] });
    for (const index of [0, 1, 2]) {
      seedEntity({
        id: `near-${String(index)}`,
        name: `Aion ${String(index)}`,
        type: 'project',
        vector: [1, 0],
        txFrom: NEWER,
      });
    }
    mention(EPISODE_ID, 'subject', 1);

    const judge = refusingJudge();
    const outcome = await new EntityDedupStage({ maxJudgments: 2 }).run(context(judge));

    expect(outcome.counts).toMatchObject({ merge_judgments: 2 });
    expect(judge.calls).toHaveLength(2);
  });

  /**
   * A capped run drops the overflow with no proposal and no other trace, so the count of what
   * was put forward is the only thing that separates a quiet graph from a budget that ran out.
   */
  it('reports what tier 1 nominated beside what it could afford to judge', async () => {
    seedEntity({ id: 'subject', name: 'Aion', type: 'project', vector: [1, 0] });
    for (const index of [0, 1, 2]) {
      seedEntity({
        id: `near-${String(index)}`,
        name: `Aion ${String(index)}`,
        type: 'project',
        vector: [1, 0],
        txFrom: NEWER,
      });
    }
    mention(EPISODE_ID, 'subject', 1);

    const outcome = await new EntityDedupStage({ maxJudgments: 1 }).run(context(refusingJudge()));

    expect(outcome.counts).toMatchObject({ merge_judgments: 1, merge_nominations: 3 });
  });

  it('never absorbs the structural node, whatever the organic entity has going for it', async () => {
    seedEntity({
      id: 'member',
      name: 'Ryan Huber',
      type: 'member',
      vector: [1, 0],
      structural: true,
      accessCount: 1,
    });
    seedEntity({
      id: 'organic',
      name: 'Ryan H',
      type: 'member',
      vector: [9, 4],
      accessCount: 40,
      txFrom: NEWER,
    });
    mention(EPISODE_ID, 'organic', 1);
    seedEpisode(OTHER_EPISODE_ID);
    mention(OTHER_EPISODE_ID, 'member', 1);

    await new EntityDedupStage().run(context());

    expect(graph.nodes.get('member')?.properties[BITEMPORAL_PROPERTIES.validUntil]).toBeUndefined();
    expect(graph.nodes.get('organic')?.properties[BITEMPORAL_PROPERTIES.validUntil]).toEqual(
      toGraphDateTime(NOW),
    );
  });

  it('skips a subject with no name vector yet rather than throwing', async () => {
    graph.seedNode('pending', ['Entity', 'Memory', 'AionNode'], {
      [ENTITY_NAME_PROPERTY]: 'Aion',
      [ENTITY_NAME_NORM_PROPERTY]: 'aion',
      [ENTITY_NAME_SQUASH_PROPERTY]: 'aion',
      type: 'project',
      [BITEMPORAL_PROPERTIES.txFrom]: OLDER,
    });
    mention(EPISODE_ID, 'pending', 1);

    const outcome = await new EntityDedupStage().run(context());

    expect(outcome.status).toBe('ok');
    expect(outcome.counts).toMatchObject({ merges: 0 });
  });

  it('skips an episode that mentions no entities', async () => {
    const outcome = await new EntityDedupStage().run(context());
    expect(outcome).toMatchObject({ status: 'skipped' });
  });

  it('respects a configured nomination threshold looser than the default', async () => {
    // Names that reach the judge either way, so the configured number is the only thing
    // deciding: cosine([1,0],[1,1]) is 0.707, under the default and over the configured one.
    seedEntity({ id: 'a', name: 'Aion', type: 'project', vector: [1, 0], accessCount: 1 });
    seedEntity({
      id: 'b',
      name: 'Aion Project',
      type: 'project',
      vector: [1, 1],
      accessCount: 0,
      txFrom: NEWER,
    });
    mention(EPISODE_ID, 'a', 1);

    expect(DEFAULTS.reflection.entityDedupThreshold).toBe(0.85);
    const strict = await new EntityDedupStage().run(context());
    expect(strict.counts).toMatchObject({ merges: 0, merge_judgments: 0 });

    const outcome = await new EntityDedupStage({ similarityThreshold: 0.5 }).run(context());

    expect(outcome.counts).toMatchObject({ merges: 1 });
  });
});

describe('tier 0, deterministic and model-free', () => {
  it('merges two separator spellings of one name without asking a model', async () => {
    seedEntity({ id: 'dashed', name: 'aion-local', type: 'project', vector: [1, 0] });
    seedEntity({
      id: 'spaced',
      name: 'aion local',
      type: 'project',
      vector: [0, 1],
      txFrom: NEWER,
    });
    mention(EPISODE_ID, 'dashed', 1);

    const outcome = await new EntityDedupStage().run(context(unreachableProvider()));

    expect(outcome.counts).toMatchObject({ merges: 1, merge_judgments: 0 });
    expect(graph.nodes.get('spaced')?.properties[BITEMPORAL_PROPERTIES.validUntil]).toEqual(
      toGraphDateTime(NOW),
    );
    expect(graph.nodes.get('dashed')?.properties[ENTITY_ALIASES_PROPERTY]).toEqual(['aion local']);
  });

  it('records the deterministic merge as tier 0 with no judge verdicts', async () => {
    seedEntity({ id: 'dashed', name: 'aion-local', type: 'project', vector: [1, 0] });
    seedEntity({
      id: 'spaced',
      name: 'aion local',
      type: 'project',
      vector: [0, 1],
      txFrom: NEWER,
    });
    mention(EPISODE_ID, 'dashed', 1);

    await new EntityDedupStage().run(context(unreachableProvider()));

    const decisions = listEntityMergeDecisions(store.db);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      canonicalId: 'dashed',
      memberIds: ['spaced'],
      tier: 'tier0',
      judge: null,
      reasons: ['both names squash to aionlocal'],
    });
    expect(decisions[0]?.signals[0]).toMatchObject({ nameFormRelation: 'squash' });
  });

  it('merges an identity that already answers to the other name as an alias', async () => {
    seedEntity({
      id: 'holder',
      name: 'Postgres',
      type: 'tool',
      vector: [1, 0],
      aliases: ['pgsql'],
    });
    seedEntity({ id: 'owner', name: 'pgsql', type: 'tool', vector: [0, 1], txFrom: NEWER });
    mention(EPISODE_ID, 'holder', 1);

    const outcome = await new EntityDedupStage().run(context(unreachableProvider()));

    expect(outcome.counts).toMatchObject({ merges: 1, merge_judgments: 0 });
    expect(graph.nodes.get('owner')?.properties[BITEMPORAL_PROPERTIES.validUntil]).toEqual(
      toGraphDateTime(NOW),
    );
    expect(listEntityMergeDecisions(store.db)[0]?.reasons).toEqual([
      "one already answers to the other's name, as the alias pgsql",
    ]);
  });

  it('refuses an alias two identities both claim, leaving it to the judged tiers', async () => {
    seedEntity({ id: 'datadog', name: 'Datadog', type: 'tool', vector: [1, 0], aliases: ['dd'] });
    seedEntity({
      id: 'diligence',
      name: 'Due Diligence',
      type: 'topic',
      vector: [0, 1],
      aliases: ['dd'],
    });
    seedEntity({ id: 'dd', name: 'dd', type: 'tool', vector: [0, 0, 1], txFrom: NEWER });
    mention(EPISODE_ID, 'datadog', 1);

    const outcome = await new EntityDedupStage().run(context(refusingJudge()));

    expect(outcome.counts).toMatchObject({ merges: 0 });
    expect(graph.nodes.get('dd')?.properties[BITEMPORAL_PROPERTIES.validUntil]).toBeUndefined();
  });

  it('never merges two instance names that differ only in their digits', async () => {
    seedEntity({ id: 'first', name: 'beta-episode-1', type: 'topic', vector: [1, 0] });
    seedEntity({
      id: 'second',
      name: 'beta episode 2',
      type: 'topic',
      vector: [1, 0],
      txFrom: NEWER,
    });
    mention(EPISODE_ID, 'first', 1);

    const outcome = await new EntityDedupStage().run(context(refusingJudge()));

    expect(outcome.counts).toMatchObject({ merges: 0 });
    expect(graph.nodes.get('second')?.properties[BITEMPORAL_PROPERTIES.validUntil]).toBeUndefined();
  });
});

describe('canonical selection', () => {
  it('counts distinct episodes rather than mention totals when it picks the survivor', async () => {
    // The loud side is named nine times inside one episode; the strong side is named once each
    // in three. A sum over `MENTIONS.count` picks the loud one, which is the bug this fixes.
    seedEntity({ id: 'loud', name: 'Aion', type: 'project', vector: [1, 0], txFrom: NEWER });
    seedEntity({ id: 'steady', name: 'Aion Project', type: 'project', vector: [1, 0] });
    seedEpisode(OTHER_EPISODE_ID);
    seedEpisode(THIRD_EPISODE_ID);
    mention(EPISODE_ID, 'loud', 9);
    mention(EPISODE_ID, 'steady', 1);
    mention(OTHER_EPISODE_ID, 'steady', 1);
    mention(THIRD_EPISODE_ID, 'steady', 1);

    await new EntityDedupStage().run(context());

    expect(graph.nodes.get('steady')?.properties[BITEMPORAL_PROPERTIES.validUntil]).toBeUndefined();
    expect(graph.nodes.get('loud')?.properties[BITEMPORAL_PROPERTIES.validUntil]).toEqual(
      toGraphDateTime(NOW),
    );
  });

  it('redirects the absorbed entity edges onto the canonical, summing on collision', async () => {
    seedEntity({
      id: 'strong',
      name: 'Aion',
      type: 'project',
      vector: [1, 0],
      accessCount: 0,
      txFrom: NEWER,
    });
    seedEntity({
      id: 'weak',
      name: 'Aion Project',
      type: 'project',
      vector: [9, 4],
      accessCount: 0,
      txFrom: OLDER,
    });
    seedEpisode(OTHER_EPISODE_ID);
    seedEpisode(THIRD_EPISODE_ID);
    mention(EPISODE_ID, 'strong', 10);
    mention(THIRD_EPISODE_ID, 'strong', 1);
    mention(OTHER_EPISODE_ID, 'weak', 5);

    await new EntityDedupStage().run(context());

    const mentions = graph.edgesOfType(ENTITY_MENTION_TYPE);
    expect(
      mentions.find((edge) => edge.sourceId === OTHER_EPISODE_ID && edge.targetId === 'strong')
        ?.count,
    ).toBe(5);

    const participations = graph.edgesOfType(ENTITY_PARTICIPATION_TYPE);
    expect(
      participations.find(
        (edge) => edge.targetId === OTHER_EPISODE_ID && edge.sourceId === 'strong',
      ),
    ).toBeDefined();
    // The stale edge off the closed node stays in place rather than being deleted.
    expect(
      mentions.some((edge) => edge.sourceId === OTHER_EPISODE_ID && edge.targetId === 'weak'),
    ).toBe(true);
  });
});

describe('idempotency', () => {
  it('gates on the ledger key and does nothing the second time', async () => {
    seedNearDuplicatePair();

    const first = await new EntityDedupStage().run(context());
    expect(first.counts).toMatchObject({ merges: 1 });

    const key = entityMergeLedgerKey(ENTITY_CASCADE_VERSION, 'strong', ['weak']);
    expect(getLedgerEntry(store.db, key)).toBeDefined();

    const supersedesAfterFirst = graph.edgesOfType(SUPERSEDES_TYPE).length;
    const second = await new EntityDedupStage().run(context());

    expect(second.counts).toMatchObject({ merges: 0 });
    expect(graph.edgesOfType(SUPERSEDES_TYPE)).toHaveLength(supersedesAfterFirst);
    expect(listEntityMergeDecisions(store.db)).toHaveLength(1);
  });

  it('records what an unmerge would need on the canonical, decision record included', async () => {
    seedEntity({
      id: 'strong',
      name: 'Aion',
      type: 'project',
      vector: [1, 0],
      txFrom: NEWER,
      accessCount: 1,
    });
    seedEntity({
      id: 'weak',
      name: 'Aion Project',
      type: 'project',
      vector: [9, 4],
      txFrom: OLDER,
      accessCount: 1,
      aliases: ['aion-project'],
    });
    seedEpisode(OTHER_EPISODE_ID);
    seedEpisode(THIRD_EPISODE_ID);
    mention(EPISODE_ID, 'strong', 9);
    mention(THIRD_EPISODE_ID, 'strong', 1);
    mention(OTHER_EPISODE_ID, 'weak', 5);

    await new EntityDedupStage().run(context());

    const records = graph.nodes.get('strong')?.properties[MERGE_PROVENANCE_PROPERTY] as string[];
    expect(records).toHaveLength(1);
    const record = JSON.parse(records[0] ?? '{}') as Record<string, unknown>;
    expect(record).toMatchObject({
      merged_id: 'weak',
      merged_name: 'Aion Project',
      merged_name_norm: 'aion project',
      merged_type: 'project',
      merged_aliases: ['aion-project'],
      merged_at: NOW.toISOString(),
      ledger_key: entityMergeLedgerKey(ENTITY_CASCADE_VERSION, 'strong', ['weak']),
      decision_key: listEntityMergeDecisions(store.db)[0]?.idempotencyKey,
    });
    // Every edge the absorbed node carried, with the count that has since been summed into the
    // canonical's own edge and can no longer be read back off it.
    expect(record.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: ENTITY_MENTION_TYPE,
          direction: 'in',
          other_id: OTHER_EPISODE_ID,
          count: 5,
          redirected: true,
        }),
      ]),
    );
  });

  it('appends rather than overwrites when a canonical absorbs a second identity', async () => {
    seedNearDuplicatePair();
    await new EntityDedupStage().run(context());

    seedEntity({
      id: 'later',
      name: 'The Aion Project',
      type: 'project',
      vector: [9, 4],
      txFrom: OLDER,
    });
    await new EntityDedupStage().run(context());

    const records = graph.nodes.get('strong')?.properties[MERGE_PROVENANCE_PROPERTY] as string[];
    expect(records).toHaveLength(2);
    expect(records.map((raw) => (JSON.parse(raw) as { merged_id: string }).merged_id)).toEqual([
      'weak',
      'later',
    ]);
    expect(listEntityMergeDecisions(store.db)).toHaveLength(2);
  });

  it('clears the merged node vectors, best-effort, once absorbed', async () => {
    seedNearDuplicatePair();

    await new EntityDedupStage().run(context());

    expect(graph.nodes.get('weak')?.properties[ENTITY_NAME_VECTOR_PROPERTY]).toBeUndefined();
  });

  it('drops the canonical name-vector hash, because the absorbed name changes what it stands for', async () => {
    seedEntity({
      id: 'strong',
      name: 'Aion',
      type: 'project',
      vector: [1, 0],
      txFrom: NEWER,
      accessCount: 3,
      nameVectorHash: 'taken-over-the-name-alone',
    });
    seedEntity({
      id: 'weak',
      name: 'Aion Project',
      type: 'project',
      vector: [9, 4],
      txFrom: OLDER,
      accessCount: 1,
    });
    seedEpisode(OTHER_EPISODE_ID);
    seedEpisode(THIRD_EPISODE_ID);
    mention(EPISODE_ID, 'strong', 3);
    mention(THIRD_EPISODE_ID, 'strong', 1);
    mention(OTHER_EPISODE_ID, 'weak', 1);

    await new EntityDedupStage().run(context());

    const strong = graph.nodes.get('strong');
    expect(strong?.properties[ENTITY_ALIASES_PROPERTY]).toEqual(['Aion Project']);
    // The vector stays where it is: nominating on a slightly stale name beats nominating on
    // nothing until the next resolution reads the missing hash and embeds the alias set.
    expect(strong?.properties[ENTITY_NAME_VECTOR_PROPERTY]).toEqual([1, 0]);
    expect(strong?.properties[ENTITY_NAME_VECTOR_HASH_PROPERTY]).toBeUndefined();
  });
});

/**
 * Vector proximity is held constant at 1.0 (the degenerate case the embedding model actually
 * produces for these inputs) so each of these turns on what the tiers do with a nomination the
 * vector alone would have merged.
 */
describe('what a vector alone cannot merge', () => {
  const IDENTICAL = [1, 0];

  function seedPair(subject: string, candidate: string, type = 'tool'): void {
    seedEntity({ id: 'subject', name: subject, type, vector: IDENTICAL, accessCount: 1 });
    seedEntity({ id: 'candidate', name: candidate, type, vector: IDENTICAL, txFrom: NEWER });
    mention(EPISODE_ID, 'subject', 1);
  }

  const PAIRS: readonly (readonly [string, string])[] = [
    ['Zoë Müller', 'José Álvarez'],
    ['naïve', 'café'],
    ['🌊', '🛰'],
    ['Redis', 'Redix'],
    ['github-token', 'gitlab-token'],
    ['beta episode 1', 'beta episode 2'],
    ['Project Helios', 'QUASARFLANGE7741'],
    ['remittance ingest', 'remittance reconciliation service'],
  ];

  it.each(PAIRS)('leaves %s and %s alone when the judge says they differ', async (a, b) => {
    seedPair(a, b);

    const outcome = await new EntityDedupStage().run(context(refusingJudge()));

    expect(outcome.counts).toMatchObject({ merges: 0, merge_proposals: 0 });
    expect(
      graph.nodes.get('candidate')?.properties[BITEMPORAL_PROPERTIES.validUntil],
    ).toBeUndefined();
  });

  it.each(PAIRS)('never reaches a deterministic tier on %s and %s', async (a, b) => {
    seedPair(a, b);

    // No model available at all: anything that merges here merged without a judgment, which is
    // what tier 0 is allowed to do and what nothing else is.
    const outcome = await new EntityDedupStage().run(context(unreachableProvider()));

    expect(outcome.counts).toMatchObject({ merges: 0 });
    expect(
      graph.nodes.get('candidate')?.properties[BITEMPORAL_PROPERTIES.validUntil],
    ).toBeUndefined();
  });

  it('judges each pair on its own and will not chain a third identity in', async () => {
    // The Postgres node absorbed Redis and Valkey this way: each merged with something the
    // other never resembled, and a group closure put all three in one node.
    seedEntity({
      id: 'postgres',
      name: 'Postgres',
      type: 'tool',
      vector: IDENTICAL,
      accessCount: 9,
    });
    seedEntity({
      id: 'postgresql',
      name: 'PostgreSQL',
      type: 'tool',
      vector: IDENTICAL,
      txFrom: NEWER,
    });
    seedEntity({ id: 'redis', name: 'Redis', type: 'tool', vector: IDENTICAL, txFrom: NEWER });
    seedEpisode(OTHER_EPISODE_ID);
    mention(EPISODE_ID, 'postgres', 9);
    mention(OTHER_EPISODE_ID, 'postgres', 1);
    mention(EPISODE_ID, 'postgresql', 1);

    const judge = scriptedJudge({
      same: (left, right) =>
        [left, right].every((name) => name.toLowerCase().startsWith('postgre')),
      review: (left, right) =>
        [left, right].every((name) => name.toLowerCase().startsWith('postgre')),
    });
    const outcome = await new EntityDedupStage().run(context(judge));

    expect(outcome.counts).toMatchObject({ merges: 1 });
    expect(graph.nodes.get('redis')?.properties[BITEMPORAL_PROPERTIES.validUntil]).toBeUndefined();
    expect(graph.nodes.get('postgres')?.properties[ENTITY_ALIASES_PROPERTY]).toEqual([
      'PostgreSQL',
    ]);
  });
});
