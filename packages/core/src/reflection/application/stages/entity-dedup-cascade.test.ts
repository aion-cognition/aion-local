import { beforeEach, describe, expect, it } from 'vitest';

import {
  EntityDetailCache,
  findTier0Groups,
  orderNominations,
  type NominatedPair,
} from './entity-dedup-cascade.js';
import { DedupFakeGraph } from './entity-dedup.fixture.js';
import { BITEMPORAL_PROPERTIES } from '../../../infrastructure/graph/bitemporal.js';
import { ENTITY_ALIASES_PROPERTY } from '../../../infrastructure/graph/entity-dedup-queries.js';
import {
  ENTITY_ALIASES_NORM_PROPERTY,
  ENTITY_MENTION_TYPE,
  ENTITY_NAME_SQUASH_PROPERTY,
  ENTITY_TYPE_PROPERTY,
} from '../../../infrastructure/graph/entity-queries.js';
import { MEMORY_PROPERTIES } from '../../../infrastructure/graph/episodes.js';
import {
  ENTITY_NAME_NORM_PROPERTY,
  ENTITY_NAME_PROPERTY,
} from '../../../infrastructure/graph/seed-queries.js';
import { squashName } from '../../domain/entity-reconciliation.js';
import { foldName } from '../../domain/name-fold.js';

/**
 * How a run spends a judge budget it cannot cover. Ranking one nominator above the other hands
 * every call to that nominator's top of list, which on names means the identifier-shaped traps:
 * two sha256 digests differing in the last byte are the highest name cosine any measured set has
 * produced, and the shared-episode nominations behind them never get asked about.
 */

function pair(left: string, right: string, signals: Partial<NominatedPair>): NominatedPair {
  return { leftId: left, rightId: right, ...signals };
}

function names(ordered: readonly NominatedPair[]): string[] {
  return ordered.map((entry) => entry.leftId);
}

describe('orderNominations', () => {
  it('alternates the two nominators rather than ranking one above the other', () => {
    const ordered = orderNominations([
      pair('cos-low', 'x', { nominatingCosine: 0.86 }),
      pair('cos-high', 'x', { nominatingCosine: 0.99 }),
      pair('jac-low', 'x', { sharedEpisodeJaccard: 0.3 }),
      pair('jac-high', 'x', { sharedEpisodeJaccard: 0.8 }),
    ]);

    expect(names(ordered)).toEqual(['cos-high', 'jac-high', 'cos-low', 'jac-low']);
  });

  it('leaves the graph nominations inside a budget the traps would have eaten whole', () => {
    const traps = [0.9868, 0.9656, 0.9137, 0.9021].map((cosine, index) =>
      pair(`trap-${String(index)}`, 'x', { nominatingCosine: cosine }),
    );
    const shared = [0.71, 0.66].map((jaccard, index) =>
      pair(`shared-${String(index)}`, 'x', { sharedEpisodeJaccard: jaccard }),
    );

    const budget = orderNominations([...traps, ...shared]).slice(0, 4);

    expect(names(budget)).toEqual(['trap-0', 'shared-0', 'trap-1', 'shared-1']);
  });

  it('emits a pair both nominators put forward once, at its first turn', () => {
    const ordered = orderNominations([
      pair('both', 'x', { nominatingCosine: 0.99, sharedEpisodeJaccard: 0.9 }),
      pair('vector-only', 'x', { nominatingCosine: 0.9 }),
      pair('graph-only', 'x', { sharedEpisodeJaccard: 0.5 }),
    ]);

    expect(names(ordered)).toEqual(['both', 'graph-only', 'vector-only']);
  });

  it('orders one nominator alone by strength, and ties by the pair key', () => {
    const ordered = orderNominations([
      pair('b', 'z', { sharedEpisodeJaccard: 0.5 }),
      pair('a', 'z', { sharedEpisodeJaccard: 0.5 }),
      pair('c', 'z', { sharedEpisodeJaccard: 0.9 }),
    ]);

    expect(names(ordered)).toEqual(['c', 'a', 'b']);
  });

  it('keeps every pair it was handed', () => {
    const pairs = [
      pair('one', 'x', { nominatingCosine: 0.9 }),
      pair('two', 'x', { sharedEpisodeJaccard: 0.4 }),
      pair('three', 'x', { nominatingCosine: 0.7, sharedEpisodeJaccard: 0.6 }),
    ];

    expect(orderNominations(pairs)).toHaveLength(pairs.length);
  });
});

/**
 * The chain the direct-relation guard exists for. Squash equality closes transitively on its
 * own, so the only way a member can reach a group without relating to the canonical is a
 * cross-reading chain: A and B squash to one key, B answers to C's name as an alias, and A
 * and C have nothing between them. Absorbing C into A on B's evidence is how one Postgres
 * node came to contain Redis.
 */

const FIRST_EPISODE_ID = 'episode-1';
const SECOND_EPISODE_ID = 'episode-2';
const TX_FROM = new Date('2026-01-01T00:00:00.000Z');

let graph: DedupFakeGraph;

type EntitySeed = {
  readonly id: string;
  readonly name: string;
  /** Distinct episodes naming it, which is the whole of what picks the canonical here. */
  readonly episodes: readonly string[];
  readonly aliases?: readonly string[];
};

function seedEntity(seed: EntitySeed): void {
  const nameNorm = foldName(seed.name);
  graph.seedNode(seed.id, ['Entity', 'Memory', 'AionNode'], {
    [ENTITY_NAME_PROPERTY]: seed.name,
    [ENTITY_NAME_NORM_PROPERTY]: nameNorm,
    [ENTITY_NAME_SQUASH_PROPERTY]: squashName(nameNorm),
    [ENTITY_TYPE_PROPERTY]: 'tool',
    [BITEMPORAL_PROPERTIES.txFrom]: TX_FROM,
    ...(seed.aliases === undefined
      ? {}
      : {
          [ENTITY_ALIASES_PROPERTY]: [...seed.aliases],
          [ENTITY_ALIASES_NORM_PROPERTY]: seed.aliases.map((alias) => foldName(alias)),
        }),
  });
  for (const episodeId of seed.episodes) {
    graph.seedEdge(ENTITY_MENTION_TYPE, episodeId, seed.id);
  }
}

/** The three identities of the chain, with the mention counts that decide the canonical. */
function seedChain(loudest: 'dashed' | 'spaced'): void {
  seedEntity({
    id: 'dashed',
    name: 'aion-local',
    episodes: loudest === 'dashed' ? [FIRST_EPISODE_ID, SECOND_EPISODE_ID] : [FIRST_EPISODE_ID],
  });
  seedEntity({
    id: 'spaced',
    name: 'aion local',
    episodes: loudest === 'spaced' ? [FIRST_EPISODE_ID, SECOND_EPISODE_ID] : [FIRST_EPISODE_ID],
    aliases: ['Redis'],
  });
  seedEntity({ id: 'redis', name: 'Redis', episodes: [FIRST_EPISODE_ID] });
}

async function tier0Groups(): Promise<
  { canonical: string; members: string[]; reasons: readonly string[] }[]
> {
  const groups = await findTier0Groups(graph.driver, new EntityDetailCache(graph.driver), {
    subjectIds: ['spaced'],
  });
  return groups.map((group) => ({
    canonical: group.canonical.id,
    members: group.members.map((member) => member.id).sort(),
    reasons: group.reasons,
  }));
}

beforeEach(() => {
  graph = new DedupFakeGraph();
  for (const id of [FIRST_EPISODE_ID, SECOND_EPISODE_ID]) {
    graph.seedNode(id, ['Episode', 'Memory', 'AionNode'], { [MEMORY_PROPERTIES.text]: 'text' });
  }
});

describe('findTier0Groups, the direct-relation guard', () => {
  it('drops the member the canonical was only ever chained to', async () => {
    seedChain('dashed');

    expect(await tier0Groups()).toEqual([
      {
        canonical: 'dashed',
        members: ['dashed', 'spaced'],
        reasons: ['both names squash to aionlocal'],
      },
    ]);
  });

  it('keeps both members when the canonical is the one identity each of them relates to', async () => {
    seedChain('spaced');

    expect(await tier0Groups()).toEqual([
      {
        canonical: 'spaced',
        members: ['dashed', 'redis', 'spaced'],
        reasons: [
          'both names squash to aionlocal',
          "one already answers to the other's name, as the alias redis",
        ],
      },
    ]);
  });
});
