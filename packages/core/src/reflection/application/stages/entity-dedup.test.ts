import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BITEMPORAL_PROPERTIES } from '../../../infrastructure/graph/bitemporal.js';
import { ACCESS_COUNT_PROPERTY } from '../../../infrastructure/graph/access-tracking.js';
import { ENTITY_ALIASES_PROPERTY } from '../../../infrastructure/graph/entity-dedup-queries.js';
import { ENTITY_MENTION_TYPE, ENTITY_PARTICIPATION_TYPE } from '../../../infrastructure/graph/entity-queries.js';
import { MEMORY_PROPERTIES } from '../../../infrastructure/graph/episodes.js';
import { SUPERSEDES_TYPE } from '../../../infrastructure/graph/relationships.js';
import {
  ENTITY_NAME_NORM_PROPERTY,
  ENTITY_NAME_PROPERTY,
  ENTITY_NAME_VECTOR_PROPERTY,
  STRUCTURAL_PROPERTY,
} from '../../../infrastructure/graph/seed-queries.js';
import { openLogger } from '../../../infrastructure/logging/logger.js';
import { getLedgerEntry } from '../../../infrastructure/sqlite/ops-ledger.js';
import { SqliteStore } from '../../../infrastructure/sqlite/database.js';
import { toGraphDateTime } from '../../../infrastructure/graph/values.js';
import type { EpisodeContext } from '../../../infrastructure/graph/episode-context.js';
import { entityMergeLedgerKey } from '../../domain/entity-merge.js';
import type { StageContext } from '../../domain/stage.js';
import { DedupFakeGraph } from './entity-dedup.fixture.js';
import { DEFAULT_ENTITY_DEDUP_SIMILARITY_THRESHOLD, EntityDedupStage } from './entity-dedup.js';

const EPISODE_ID = 'episode-1';
const SESSION_ID = 'session-1';
const OTHER_EPISODE_ID = 'episode-0';
const NOW = new Date('2026-08-28T09:05:00.000Z');
const OLDER = new Date('2026-01-01T00:00:00.000Z');
const NEWER = new Date('2026-06-01T00:00:00.000Z');

let graph: DedupFakeGraph;
let store: SqliteStore;
let dataDir: string;

function episode(): EpisodeContext {
  return { id: EPISODE_ID, sessionId: SESSION_ID, text: '', turns: [] };
}

function context(): StageContext {
  return {
    driver: graph.driver,
    db: store.db,
    provider: {
      embed: async () => [],
      generate: async () => ({}),
    },
    episodeId: EPISODE_ID,
    episode: episode(),
    logger: openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' }),
    now: NOW,
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
};

function seedEntity(seed: EntitySeed): void {
  graph.seedNode(seed.id, ['Entity', 'Memory', 'AionNode'], {
    [ENTITY_NAME_PROPERTY]: seed.name,
    [ENTITY_NAME_NORM_PROPERTY]: seed.name.toLowerCase(),
    type: seed.type,
    [ENTITY_NAME_VECTOR_PROPERTY]: [...seed.vector],
    [BITEMPORAL_PROPERTIES.txFrom]: seed.txFrom ?? OLDER,
    ...(seed.structural === true ? { [STRUCTURAL_PROPERTY]: true } : {}),
    ...(seed.accessCount === undefined ? {} : { [ACCESS_COUNT_PROPERTY]: seed.accessCount }),
    ...(seed.aliases === undefined ? {} : { [ENTITY_ALIASES_PROPERTY]: [...seed.aliases] }),
    ...(seed.superseded === true ? { [BITEMPORAL_PROPERTIES.validUntil]: OLDER } : {}),
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
  const edge = graph.edgesOfType(ENTITY_MENTION_TYPE).find(
    (candidate) => candidate.sourceId === episodeId && candidate.targetId === entityId,
  );
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

describe('grouping and canonical selection', () => {
  it('merges a near-duplicate into the more-mentioned identity and closes the loser', async () => {
    seedEntity({ id: 'strong', name: 'Aion', type: 'project', vector: [1, 0], txFrom: NEWER, accessCount: 3 });
    seedEntity({ id: 'weak', name: 'Aion Project', type: 'project', vector: [9, 4], txFrom: OLDER, accessCount: 1 });
    mention(EPISODE_ID, 'strong', 3);
    seedEpisode(OTHER_EPISODE_ID);
    mention(OTHER_EPISODE_ID, 'weak', 1);

    const outcome = await new EntityDedupStage().run(context());

    expect(outcome.status).toBe('ok');
    expect(outcome.counts).toEqual({ merges: 1 });

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

  it('redirects the absorbed entity edges onto the canonical, summing on collision', async () => {
    seedEntity({ id: 'strong', name: 'Aion', type: 'project', vector: [1, 0], accessCount: 0, txFrom: NEWER });
    seedEntity({ id: 'weak', name: 'Aion Project', type: 'project', vector: [9, 4], accessCount: 0, txFrom: OLDER });
    mention(EPISODE_ID, 'strong', 10);
    seedEpisode(OTHER_EPISODE_ID);
    mention(OTHER_EPISODE_ID, 'weak', 5);

    await new EntityDedupStage().run(context());

    const mentions = graph.edgesOfType(ENTITY_MENTION_TYPE);
    const fromOther = mentions.find(
      (edge) => edge.sourceId === OTHER_EPISODE_ID && edge.targetId === 'strong',
    );
    expect(fromOther?.count).toBe(5);

    const participations = graph.edgesOfType(ENTITY_PARTICIPATION_TYPE);
    expect(
      participations.find((edge) => edge.targetId === OTHER_EPISODE_ID && edge.sourceId === 'strong'),
    ).toBeDefined();
    // The stale edge off the closed node is left in place rather than deleted; only the fresh one is current.
    expect(mentions.some((edge) => edge.sourceId === OTHER_EPISODE_ID && edge.targetId === 'weak')).toBe(true);
  });

  it('never absorbs the structural node, whatever the organic entity has going for it', async () => {
    seedEntity({ id: 'member', name: 'Ryan Huber', type: 'member', vector: [1, 0], structural: true, accessCount: 1 });
    seedEntity({ id: 'organic', name: 'Ryan H', type: 'member', vector: [9, 4], accessCount: 40, txFrom: NEWER });
    mention(EPISODE_ID, 'organic', 1);
    seedEpisode(OTHER_EPISODE_ID);
    mention(OTHER_EPISODE_ID, 'member', 1);

    await new EntityDedupStage().run(context());

    const member = graph.nodes.get('member');
    const organic = graph.nodes.get('organic');
    expect(member?.properties[BITEMPORAL_PROPERTIES.validUntil]).toBeUndefined();
    expect(organic?.properties[BITEMPORAL_PROPERTIES.validUntil]).toEqual(toGraphDateTime(NOW));
  });

  it('does not merge across types even at high name similarity', async () => {
    seedEntity({ id: 'project', name: 'Aion', type: 'project', vector: [1, 0] });
    seedEntity({ id: 'person', name: 'Aion', type: 'person', vector: [1, 0] });
    mention(EPISODE_ID, 'project', 1);

    const outcome = await new EntityDedupStage().run(context());

    expect(outcome.counts).toEqual({ merges: 0 });
    expect(graph.nodes.get('person')?.properties[BITEMPORAL_PROPERTIES.validUntil]).toBeUndefined();
  });

  it('leaves entities below the similarity threshold alone', async () => {
    seedEntity({ id: 'a', name: 'Aion', type: 'project', vector: [1, 0] });
    seedEntity({ id: 'b', name: 'Postgres', type: 'project', vector: [1, 1] });
    mention(EPISODE_ID, 'a', 1);

    const outcome = await new EntityDedupStage().run(context());

    expect(outcome.counts).toEqual({ merges: 0 });
    expect(graph.nodes.get('b')?.properties[BITEMPORAL_PROPERTIES.validUntil]).toBeUndefined();
  });

  it('skips a subject with no name vector yet rather than throwing', async () => {
    graph.seedNode('pending', ['Entity', 'Memory', 'AionNode'], {
      [ENTITY_NAME_PROPERTY]: 'Aion',
      [ENTITY_NAME_NORM_PROPERTY]: 'aion',
      type: 'project',
      [BITEMPORAL_PROPERTIES.txFrom]: OLDER,
    });
    mention(EPISODE_ID, 'pending', 1);

    const outcome = await new EntityDedupStage().run(context());

    expect(outcome.status).toBe('ok');
    expect(outcome.counts).toEqual({ merges: 0 });
  });

  it('skips an episode that mentions no entities', async () => {
    const outcome = await new EntityDedupStage().run(context());
    expect(outcome).toMatchObject({ status: 'skipped' });
  });

  it('respects a configured threshold looser than the default', async () => {
    seedEntity({ id: 'a', name: 'Aion', type: 'project', vector: [1, 0], accessCount: 1 });
    seedEntity({ id: 'b', name: 'Postgres', type: 'project', vector: [1, 1], accessCount: 0, txFrom: NEWER });
    mention(EPISODE_ID, 'a', 1);

    expect(DEFAULT_ENTITY_DEDUP_SIMILARITY_THRESHOLD).toBe(0.85);
    const outcome = await new EntityDedupStage({ similarityThreshold: 0.5 }).run(context());

    expect(outcome.counts).toEqual({ merges: 1 });
  });
});

describe('idempotency', () => {
  it('gates on the ledger key and does nothing the second time', async () => {
    seedEntity({ id: 'strong', name: 'Aion', type: 'project', vector: [1, 0], txFrom: NEWER, accessCount: 1 });
    seedEntity({ id: 'weak', name: 'Aion Project', type: 'project', vector: [9, 4], txFrom: OLDER, accessCount: 1 });
    mention(EPISODE_ID, 'strong', 1);

    const first = await new EntityDedupStage().run(context());
    expect(first.counts).toEqual({ merges: 1 });

    const key = entityMergeLedgerKey('strong', ['weak']);
    expect(getLedgerEntry(store.db, key)).toBeDefined();

    const supersedesAfterFirst = graph.edgesOfType(SUPERSEDES_TYPE).length;
    const second = await new EntityDedupStage().run(context());

    expect(second.counts).toEqual({ merges: 0 });
    expect(graph.edgesOfType(SUPERSEDES_TYPE)).toHaveLength(supersedesAfterFirst);
  });

  it('clears the merged node vectors, best-effort, once absorbed', async () => {
    seedEntity({ id: 'strong', name: 'Aion', type: 'project', vector: [1, 0], txFrom: NEWER, accessCount: 1 });
    seedEntity({ id: 'weak', name: 'Aion Project', type: 'project', vector: [9, 4], txFrom: OLDER, accessCount: 1 });
    mention(EPISODE_ID, 'strong', 1);

    await new EntityDedupStage().run(context());

    const weak = graph.nodes.get('weak');
    expect(weak?.properties[ENTITY_NAME_VECTOR_PROPERTY]).toBeUndefined();
  });
});
