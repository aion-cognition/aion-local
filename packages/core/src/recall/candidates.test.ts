import { describe, expect, it } from 'vitest';
import { DEFAULTS } from '../config/defaults.js';
import type { Config } from '../config/schema.js';
import type { SeedCandidate } from '../graph/seed-queries.js';
import type { ActivatedNode } from './activation.js';
import {
  buildRankedLists,
  seedCandidate,
  toActivationSeed,
  traversalCandidates,
} from './candidates.js';
import type { Seed, SeedProvenance } from './seeds.js';

const SUPERSEDED_AT = new Date('2026-08-10T00:00:00.000Z');

function seed(id: string, provenance: readonly SeedProvenance[], superseded = false): Seed {
  const best = provenance[0];
  const base = {
    id,
    labels: ['Episode', 'Memory', 'AionNode'],
    content: `content of ${id}`,
    score: best?.score ?? 0,
    provenance,
  };
  if (!superseded) {
    return { ...base, currency: 'current' };
  }
  return {
    ...base,
    currency: 'superseded',
    supersededBy: { id: `${id}-successor`, at: SUPERSEDED_AT },
  };
}

function activated(nodeId: string, score: number, pathSummary: string): ActivatedNode {
  return {
    nodeId,
    score,
    hops: pathSummary === nodeId ? 0 : 2,
    pathSummary,
    currency: { currency: 'current' },
  };
}

function hydratedNode(id: string): SeedCandidate {
  return {
    id,
    labels: ['Episode', 'Memory', 'AionNode'],
    content: `content of ${id}`,
    currency: 'current',
  };
}

describe('a seed as a fusion candidate', () => {
  it('is explained by the strategy that found it at that strategy own score', () => {
    const candidate = seedCandidate(
      seed('e1', [
        { strategy: 'bm25', score: 0.9, cue: 'SQLITE_BUSY' },
        { strategy: 'recency', score: 0.5 },
      ]),
    );

    expect(candidate?.rationale).toEqual({ method: 'bm25', score: 0.9 });
    expect(candidate?.relevance).toBe(0.9);
  });

  it('carries the lineage annotation through to the item', () => {
    const candidate = seedCandidate(seed('old', [{ strategy: 'vector', score: 0.7 }], true));

    expect(candidate?.currency).toBe('superseded');
    expect(candidate?.supersededBy).toEqual({ id: 'old-successor', at: SUPERSEDED_AT });
  });

  it('enters the spread at its own currency, so a superseded seed starts down-weighted', () => {
    expect(toActivationSeed(seed('old', [{ strategy: 'vector', score: 0.7 }], true))).toEqual({
      nodeId: 'old',
      currency: { currency: 'superseded', supersededBy: { id: 'old-successor', at: SUPERSEDED_AT } },
    });
  });
});

describe('the traversal list', () => {
  const found = seed('found', [{ strategy: 'vector', score: 0.9, cue: 'webhooks' }]);

  it('explains a traversal-only node by activation, with the path that reached it', () => {
    const path = 'found -[PARTICIPATES_IN]-> session -[PARTICIPATES_IN]-> reached';
    const candidates = traversalCandidates({
      seeds: [found],
      activated: [activated('found', 1, 'found'), activated('reached', 0.39, path)],
      hydrated: new Map([['reached', hydratedNode('reached')]]),
    });

    expect(candidates.map((candidate) => candidate.id)).toEqual(['found', 'reached']);
    expect(candidates[0]?.rationale).toEqual({ method: 'vector', score: 0.9 });
    expect(candidates[1]?.rationale).toEqual({ method: 'activation', score: 0.39, path });
  });

  it('keeps a seed that fell under the activation threshold', () => {
    const candidates = traversalCandidates({
      seeds: [found, seed('quiet', [{ strategy: 'recency', score: 0.5 }])],
      activated: [activated('found', 1, 'found')],
      hydrated: new Map(),
    });

    expect(candidates.map((candidate) => candidate.id)).toEqual(['found', 'quiet']);
  });

  it('skips an activated node nothing could hydrate', () => {
    const candidates = traversalCandidates({
      seeds: [found],
      activated: [activated('found', 1, 'found'), activated('gone', 0.4, 'found -[X]-> gone')],
      hydrated: new Map(),
    });

    expect(candidates.map((candidate) => candidate.id)).toEqual(['found']);
  });
});

describe('the ranked lists fusion receives', () => {
  const vectorSeed = seed('v1', [{ strategy: 'vector', score: 0.9 }]);
  const bm25Seed = seed('b1', [{ strategy: 'bm25', score: 0.6 }]);

  function lists(config: Config) {
    return buildRankedLists(config, {
      seeds: [vectorSeed, bm25Seed],
      activated: [activated('v1', 1, 'v1')],
      hydrated: new Map(),
      byStrategy: { vector: [vectorSeed], bm25: [bm25Seed] },
    });
  }

  it('builds one weighted list per configured method', () => {
    expect(
      lists(DEFAULTS).map((list) => ({ leg: list.leg, weight: list.weight })),
    ).toEqual([
      { leg: 'vector', weight: 0.4 },
      { leg: 'bm25', weight: 0.3 },
      { leg: 'graph_traversal', weight: 0.3 },
    ]);
  });

  it('drops a method the config turned off without touching the strategies behind it', () => {
    const config: Config = {
      ...DEFAULTS,
      search: { ...DEFAULTS.search, methods: ['graph_traversal'] },
    };

    const built = lists(config);
    expect(built.map((list) => list.leg)).toEqual(['graph_traversal']);
    // The vector-found seed still reaches fusion, through the leg that is still on.
    expect(built[0]?.candidates.map((candidate) => candidate.id)).toEqual(['v1', 'b1']);
  });
});
