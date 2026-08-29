import type { RecallMethod } from '@aion/protocol';
import { describe, expect, it } from 'vitest';
import type { Vector } from '../../infrastructure/providers/types.js';
import type { AdmissionPolicy, Measurement } from './admission.js';
import {
  fuse,
  reciprocalRank,
  SUPERSEDED_RANK_WEIGHT,
  type FusedItem,
  type FusionCandidate,
  type FusionOptions,
  type RankedList,
} from './fusion.js';

const RRF_CONSTANT = 60;

/**
 * Fusion's other half: what an admitted item is explained by, and the order the pack sees.
 * Admission itself is `fusion.test.ts`; these run under a policy that admits everything except
 * where a case is about the floor's interaction with ordering.
 */
const ADMIT_ALL: AdmissionPolicy = { vectorFloor: 0, corroborationFloor: 0, bm25Mode: 'any' };

/** The shipped shape: a calibrated cosine floor, a lower corroboration floor, exact-only BM25. */
const CALIBRATED: AdmissionPolicy = {
  vectorFloor: 0.6,
  corroborationFloor: 0.55,
  bm25Mode: 'exact',
};

const RRF: FusionOptions = {
  rrfConstant: RRF_CONSTANT,
  admission: ADMIT_ALL,
  reranker: 'rrf',
  mmrLambda: 0.5,
  clusterCap: 2,
};

type CandidateOverrides = {
  readonly content?: string;
  readonly method?: RecallMethod;
  readonly relevance?: number;
  readonly superseded?: boolean;
  readonly activation?: number;
  readonly structural?: boolean;
  readonly labels?: readonly string[];
  readonly evidence?: readonly Measurement[];
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
    ...(overrides.evidence === undefined ? {} : { evidence: overrides.evidence }),
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

function items(lists: readonly RankedList[], options: FusionOptions = RRF): readonly FusedItem[] {
  return fuse(lists, options).items;
}

function ids(fused: readonly { readonly id: string }[]): string[] {
  return fused.map((item) => item.id);
}

describe('structural nodes', () => {
  it('never packs the backbone, however strongly the spread activated it', () => {
    const fused = items(
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
      { ...RRF, admission: CALIBRATED },
    );

    expect(ids(fused)).toEqual(['episode']);
  });
});

describe('rationale', () => {
  it('explains an item by its strongest leg, not by the activation pass that re-found it', () => {
    const fused = items([
      list('vector', [candidate('seed', { method: 'vector', relevance: 0.9 })]),
      list('graph_traversal', [candidate('seed', { method: 'activation', relevance: 0.4 })]),
    ]);

    expect(fused[0]?.rationale).toEqual({ method: 'vector', score: 0.9 });
  });

  it('leaves an item the spread re-found explained by the leg that measured it', () => {
    const fused = items(
      [
        list('vector', [candidate('anchor', { relevance: 0.8 })]),
        list('graph_traversal', [
          candidate('anchor', { method: 'activation', relevance: 0.4, activation: 0.4 }),
        ]),
      ],
      { ...RRF, admission: CALIBRATED },
    );

    expect(fused[0]?.rationale.method).toBe('vector');
  });
});

describe('content dedupe', () => {
  it('keeps the higher-ranked of two node ids carrying the same text', () => {
    const fused = items([
      list('vector', [
        candidate('first', { content: 'we keyed the sync on id_slug' }),
        candidate('second', { content: 'we keyed the sync on id_slug' }),
      ]),
    ]);

    expect(ids(fused)).toEqual(['first']);
  });
});

describe('currency resolution', () => {
  it('ranks the current fact above the superseded one they otherwise tie with', () => {
    const fused = items([
      list('vector', [candidate('current-fact')]),
      list('bm25', [candidate('old-fact', { method: 'bm25', superseded: true })]),
    ]);

    expect(ids(fused)).toEqual(['current-fact', 'old-fact']);
    expect(fused[1]?.score).toBeCloseTo((fused[0]?.score ?? 0) * SUPERSEDED_RANK_WEIGHT, 10);
  });

  it('surfaces the superseded item marked with its lineage rather than filtering it out', () => {
    const fused = items([list('vector', [candidate('old-fact', { superseded: true })])]);

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
    expect(ids(items([list('vector', candidates)], { ...RRF, vectors }))).toEqual([
      'a',
      'a-twin',
      'c',
    ]);
  });

  it('pushes the near-duplicate below the distinct item when it is', () => {
    const fused = items([list('vector', candidates)], {
      ...RRF,
      reranker: 'mmr',
      mmrLambda: 0.5,
      vectors,
    });

    expect(ids(fused)).toEqual(['a', 'c', 'a-twin']);
  });

  it('falls back to relevance order when no vectors are available', () => {
    const fused = items([list('vector', candidates)], { ...RRF, reranker: 'mmr', mmrLambda: 0.5 });
    expect(ids(fused)).toEqual(['a', 'a-twin', 'c']);
  });

  it('keeps relevance order at lambda 1, where diversity counts for nothing', () => {
    const fused = items([list('vector', candidates)], {
      ...RRF,
      reranker: 'mmr',
      mmrLambda: 1,
      vectors,
    });

    expect(ids(fused)).toEqual(['a', 'a-twin', 'c']);
  });
});

describe('near-duplicate crowding cap', () => {
  /** The measured burst shape: a one-line record that varies only in its trailing count. */
  const BURST_CLUSTER = Array.from({ length: 20 }, (_, index) =>
    candidate(`burst-${String(index)}`, { content: `restart burst 0/${String(index)}` }),
  );

  const DISTINCT = [
    candidate('distinct-a', { content: 'the migration deadlocked on a read-only join' }),
    candidate('distinct-b', { content: 'redis backs the session cache' }),
    candidate('distinct-c', { content: 'the cue model is qwen3 1.7b' }),
    candidate('distinct-d', { content: 'entity dedup folds case before embedding' }),
    candidate('distinct-e', { content: 'the ledger key is per stage now' }),
  ];

  it('holds two of a twenty-item burst cluster plus every distinct item', () => {
    const fused = items([list('vector', [...BURST_CLUSTER, ...DISTINCT])]);

    expect(fused.filter((item) => item.id.startsWith('burst-'))).toHaveLength(2);
    expect(ids(fused)).toEqual(expect.arrayContaining(DISTINCT.map((item) => item.id)));
    expect(fused).toHaveLength(2 + DISTINCT.length);
  });

  it('keeps the best-ranked members of the cluster, since RRF rank order decides who survives', () => {
    const fused = items([list('vector', BURST_CLUSTER)]);
    expect(ids(fused)).toEqual(['burst-0', 'burst-1']);
  });

  it('counts what the cap declined, distinct from exact-content dedupe', () => {
    const result = fuse([list('vector', BURST_CLUSTER)], RRF);
    expect(result.admission.admitted).toBe(2);
    expect(result.admission.droppedNearDuplicate).toBe(18);
    expect(result.admission.droppedDuplicateContent).toBe(0);
  });

  it('honors a configured cap other than the default', () => {
    expect(items([list('vector', BURST_CLUSTER)], { ...RRF, clusterCap: 1 })).toHaveLength(1);
    expect(items([list('vector', BURST_CLUSTER)], { ...RRF, clusterCap: 5 })).toHaveLength(5);
  });

  it('never merges two clusters across pack buckets, even on a matching prefix', () => {
    const fused = items(
      [
        list('vector', [
          candidate('episode-burst', { content: 'restart burst 0/1a', labels: ['Episode', 'Memory'] }),
          candidate('concept-burst', { content: 'restart burst 0/1b', labels: ['Concept', 'Memory'] }),
        ]),
      ],
      { ...RRF, clusterCap: 1 },
    );

    expect(ids(fused).sort()).toEqual(['concept-burst', 'episode-burst']);
  });

  it('clusters by cosine when embeddings are already in hand, even across differing wording', () => {
    const vectors: ReadonlyMap<string, Vector> = new Map([
      ['near-a', [1, 0, 0]],
      ['near-b', [0.99, 0.01, 0]],
      ['near-c', [0.98, 0.02, 0]],
      ['far', [0, 1, 0]],
    ]);
    const fused = items(
      [
        list('vector', [
          candidate('near-a', { content: 'Redis serves as the session cache for the platform.' }),
          candidate('near-b', { content: 'Redis is used as the session cache.' }),
          candidate('near-c', { content: 'The session cache is Redis.' }),
          candidate('far', { content: 'The cue model times out past eight seconds.' }),
        ]),
      ],
      { ...RRF, clusterCap: 2, vectors },
    );

    expect(ids(fused).filter((id) => id.startsWith('near-'))).toHaveLength(2);
    expect(ids(fused)).toContain('far');
  });
});

describe('an empty candidate set', () => {
  it('fuses to nothing rather than inventing a floor-passing item', () => {
    expect(items([])).toEqual([]);
    expect(items([list('vector', [])])).toEqual([]);
  });
});

describe('the decision-intent label boost', () => {
  const BOOSTED: FusionOptions = { ...RRF, labelBoosts: { Decision: 1.25, Insight: 1.25 } };

  function ranked(count: number, labels: readonly string[]): FusionCandidate[] {
    return Array.from({ length: count }, (_, index) =>
      candidate(`${labels[0] ?? 'x'}-${String(index)}`, { labels: [...labels, 'Memory'] }),
    );
  }

  it('lifts a Decision the lexical leg buried past the glosses above it', () => {
    const glosses = ranked(12, ['Entity']);
    const decision = candidate('decision', { labels: ['Decision', 'Memory'] });

    const fused = items([list('bm25', [...glosses, decision])], BOOSTED);

    expect(ids(fused)[0]).toBe('decision');
  });

  it('leaves the order alone on a query with no judged intent', () => {
    const glosses = ranked(12, ['Entity']);
    const decision = candidate('decision', { labels: ['Decision', 'Memory'] });

    const fused = items([list('bm25', [...glosses, decision])]);

    expect(ids(fused)[0]).toBe('Entity-0');
    expect(ids(fused).at(-1)).toBe('decision');
  });

  // The boost is a thumb on the scale, not a bypass: an item no leg ranked at all is not in
  // the fusion to be boosted, and one ranked far below the cap stays below it.
  it('does not lift a Decision past an item ranked twenty places above it', () => {
    const glosses = ranked(30, ['Entity']);
    const decision = candidate('decision', { labels: ['Decision', 'Memory'] });

    const fused = items([list('bm25', [...glosses, decision])], BOOSTED);

    expect(ids(fused)[0]).toBe('Entity-0');
  });

  it('cannot admit an item the floors rejected', () => {
    const decision = candidate('decision', {
      labels: ['Decision', 'Memory'],
      method: 'vector',
      relevance: 0.2,
    });

    const fused = items([list('vector', [decision])], { ...BOOSTED, admission: CALIBRATED });

    expect(fused).toEqual([]);
  });
});
