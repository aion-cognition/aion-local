import type { RecallMethod } from '@aion/protocol';
import { describe, expect, it } from 'vitest';
import type { Vector } from '../providers/types.js';
import {
  cosineSimilarity,
  fuse,
  reciprocalRank,
  SUPERSEDED_RANK_WEIGHT,
  type FusionCandidate,
  type FusionOptions,
  type RankedList,
} from './fusion.js';

const RRF_CONSTANT = 60;

const RRF: FusionOptions = {
  rrfConstant: RRF_CONSTANT,
  minRelevance: 0,
  reranker: 'rrf',
  mmrLambda: 0.5,
};

type CandidateOverrides = {
  readonly content?: string;
  readonly method?: RecallMethod;
  readonly relevance?: number;
  readonly superseded?: boolean;
  readonly activation?: number;
  readonly structural?: boolean;
  readonly labels?: readonly string[];
};

function candidate(id: string, overrides: CandidateOverrides = {}): FusionCandidate {
  const method = overrides.method ?? 'vector';
  const relevance = overrides.relevance ?? 0.8;
  const base = {
    id,
    labels: overrides.labels ?? ['Episode', 'Memory'],
    content: overrides.content ?? `content of ${id}`,
    rationale: { method, score: overrides.activation ?? relevance },
    relevance,
    ...(overrides.activation === undefined ? {} : { activation: overrides.activation }),
    ...(overrides.structural === undefined ? {} : { isStructural: overrides.structural }),
  };
  if (overrides.superseded !== true) {
    return { ...base, currency: 'current' as const };
  }
  return {
    ...base,
    currency: 'superseded' as const,
    supersededBy: { id: `${id}-successor`, at: new Date('2026-08-01T00:00:00.000Z') },
  };
}

function list(
  leg: RankedList['leg'],
  candidates: readonly FusionCandidate[],
  weight = 1,
): RankedList {
  return { leg, weight, candidates };
}

function ids(items: readonly { readonly id: string }[]): string[] {
  return items.map((item) => item.id);
}

describe('reciprocal rank', () => {
  it('counts ranks from one, so the top hit of a list scores 1/(k+1)', () => {
    expect(reciprocalRank(0, RRF_CONSTANT)).toBeCloseTo(1 / 61, 10);
    expect(reciprocalRank(1, RRF_CONSTANT)).toBeCloseTo(1 / 62, 10);
  });
});

describe('RRF across ranked lists', () => {
  it('ranks an item both lists disagree about above one both rank second', () => {
    const fused = fuse(
      [
        list('vector', [candidate('a'), candidate('b'), candidate('c')]),
        list('bm25', [candidate('c'), candidate('b'), candidate('a')]),
      ],
      RRF,
    );

    // a and c each score 1/61 + 1/63; b scores 2/62, which is lower.
    expect(ids(fused)).toEqual(['a', 'c', 'b']);
  });

  it('weights each leg by its whitepaper 5.3 share, so a vector-only hit outranks a bm25-only one', () => {
    const fused = fuse(
      [list('vector', [candidate('v')], 0.4), list('bm25', [candidate('k')], 0.3)],
      RRF,
    );

    expect(ids(fused)).toEqual(['v', 'k']);
    expect(fused[0]?.score).toBeCloseTo(0.4 / 61, 10);
    expect(fused[1]?.score).toBeCloseTo(0.3 / 61, 10);
  });

  it('keeps a contentless hit out of the pack without promoting what ranked under it', () => {
    const withGap = fuse([list('vector', [candidate('blank', { content: '   ' }), candidate('b')])], RRF);
    const control = fuse([list('vector', [candidate('a'), candidate('b')])], RRF);

    expect(ids(withGap)).toEqual(['b']);
    expect(withGap[0]?.score).toBeCloseTo(control[1]?.score ?? 0, 10);
  });
});

describe('the minimum relevance floor', () => {
  it('drops an item under the floor even though nothing else competes for the slot', () => {
    const fused = fuse([list('vector', [candidate('weak', { relevance: 0.2 })])], {
      ...RRF,
      minRelevance: 0.35,
    });

    expect(fused).toEqual([]);
  });

  it('measures the floor against the best leg, not the last one to find the item', () => {
    const fused = fuse(
      [
        list('vector', [candidate('both', { relevance: 0.5 })]),
        list('bm25', [candidate('both', { method: 'bm25', relevance: 0.2 })]),
      ],
      { ...RRF, minRelevance: 0.35 },
    );

    expect(ids(fused)).toEqual(['both']);
    expect(fused[0]?.relevance).toBe(0.5);
  });

  it('measures the floor against retrieval scores, not the fused rank score', () => {
    const fused = fuse([list('vector', [candidate('strong', { relevance: 0.9 })])], {
      ...RRF,
      minRelevance: 0.35,
    });

    // The RRF score is ~0.016; a floor read against it would empty every pack.
    expect(fused[0]?.score).toBeLessThan(0.35);
    expect(ids(fused)).toEqual(['strong']);
  });
});

describe('traversal admission', () => {
  /** The gate-scale shape: a strong direct hit, plus a node only the spread reached. */
  function anchoredRun(anchorRelevance: number) {
    return fuse(
      [
        list('vector', [candidate('anchor', { relevance: anchorRelevance })]),
        list('graph_traversal', [
          candidate('anchor', { relevance: anchorRelevance }),
          candidate('reached', { method: 'activation', relevance: 0, activation: 0.29 }),
        ]),
      ],
      { ...RRF, minRelevance: 0.35 },
    );
  }

  it('surfaces a node only traversal found, under an activation score the floor would reject', () => {
    const fused = anchoredRun(0.8);

    expect(ids(fused)).toEqual(['anchor', 'reached']);
    expect(fused[1]?.rationale.method).toBe('activation');
  });

  it('surfaces nothing when no hit cleared the floor, so traversal cannot fill an empty pack', () => {
    expect(anchoredRun(0.2)).toEqual([]);
  });

  it('still drops a seed whose only strategy measured nothing', () => {
    const fused = fuse(
      [
        list('vector', [candidate('anchor', { relevance: 0.8 })]),
        list('graph_traversal', [
          candidate('anchor', { relevance: 0.8 }),
          candidate('recent', { method: 'recency', relevance: 0 }),
        ]),
      ],
      { ...RRF, minRelevance: 0.35 },
    );

    expect(ids(fused)).toEqual(['anchor']);
  });
});

describe('structural nodes', () => {
  it('never packs the backbone, however strongly the spread activated it', () => {
    const fused = fuse(
      [
        list('vector', [candidate('episode', { relevance: 0.8 })]),
        list('graph_traversal', [
          candidate('member', {
            method: 'activation',
            labels: ['Member', 'Entity'],
            relevance: 0,
            activation: 1.71,
            structural: true,
          }),
          candidate('episode', { relevance: 0.8 }),
        ]),
      ],
      { ...RRF, minRelevance: 0.35 },
    );

    expect(ids(fused)).toEqual(['episode']);
  });
});

describe('rationale', () => {
  it('explains an item by its strongest leg, not by the activation pass that re-found it', () => {
    const fused = fuse(
      [
        list('vector', [candidate('seed', { method: 'vector', relevance: 0.9 })]),
        list('graph_traversal', [candidate('seed', { method: 'activation', relevance: 0.4 })]),
      ],
      RRF,
    );

    expect(fused[0]?.rationale).toEqual({ method: 'vector', score: 0.9 });
  });

  it('leaves a traversal-only item explained by activation', () => {
    const fused = fuse(
      [list('graph_traversal', [candidate('reached', { method: 'activation', relevance: 0.4 })])],
      RRF,
    );

    expect(fused[0]?.rationale.method).toBe('activation');
  });
});

describe('content dedupe', () => {
  it('keeps the higher-ranked of two node ids carrying the same text', () => {
    const fused = fuse(
      [
        list('vector', [
          candidate('first', { content: 'we keyed the sync on id_slug' }),
          candidate('second', { content: 'we keyed the sync on id_slug' }),
        ]),
      ],
      RRF,
    );

    expect(ids(fused)).toEqual(['first']);
  });
});

describe('currency resolution', () => {
  it('ranks the current fact above the superseded one they otherwise tie with', () => {
    const fused = fuse(
      [
        list('vector', [candidate('current-fact')]),
        list('bm25', [candidate('old-fact', { method: 'bm25', superseded: true })]),
      ],
      RRF,
    );

    expect(ids(fused)).toEqual(['current-fact', 'old-fact']);
    expect(fused[1]?.score).toBeCloseTo((fused[0]?.score ?? 0) * SUPERSEDED_RANK_WEIGHT, 10);
  });

  it('surfaces the superseded item marked with its lineage rather than filtering it out', () => {
    const fused = fuse([list('vector', [candidate('old-fact', { superseded: true })])], RRF);

    expect(fused[0]?.currency).toBe('superseded');
    expect(fused[0]?.supersededBy?.id).toBe('old-fact-successor');
  });
});

describe('MMR reranking behind the flag', () => {
  const vectors: ReadonlyMap<string, Vector> = new Map<string, Vector>([
    ['a', [1, 0, 0]],
    ['a-twin', [0.99, 0.01, 0]],
    ['c', [0, 1, 0]],
  ]);

  const candidates = [candidate('a'), candidate('a-twin'), candidate('c')];

  it('leaves the RRF order alone when the reranker is not selected', () => {
    const fused = fuse([list('vector', candidates)], { ...RRF, vectors });
    expect(ids(fused)).toEqual(['a', 'a-twin', 'c']);
  });

  it('pushes the near-duplicate below the distinct item when it is', () => {
    const fused = fuse([list('vector', candidates)], {
      ...RRF,
      reranker: 'mmr',
      mmrLambda: 0.5,
      vectors,
    });

    expect(ids(fused)).toEqual(['a', 'c', 'a-twin']);
  });

  it('falls back to relevance order when no vectors are available', () => {
    const fused = fuse([list('vector', candidates)], { ...RRF, reranker: 'mmr', mmrLambda: 0.5 });
    expect(ids(fused)).toEqual(['a', 'a-twin', 'c']);
  });

  it('keeps relevance order at lambda 1, where diversity counts for nothing', () => {
    const fused = fuse([list('vector', candidates)], {
      ...RRF,
      reranker: 'mmr',
      mmrLambda: 1,
      vectors,
    });

    expect(ids(fused)).toEqual(['a', 'a-twin', 'c']);
  });
});

describe('cosine similarity', () => {
  it('scores identical vectors at one and orthogonal vectors at zero', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  it('scores a mismatched or zero vector at zero rather than throwing', () => {
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

describe('an empty candidate set', () => {
  it('fuses to nothing rather than inventing a floor-passing item', () => {
    expect(fuse([], RRF)).toEqual([]);
    expect(fuse([list('vector', [])], RRF)).toEqual([]);
  });
});
