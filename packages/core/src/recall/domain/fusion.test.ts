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
 * The ranking tests are about order, not admission, so they run under a policy that admits
 * everything. Every floor assertion names its own policy.
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

describe('reciprocal rank', () => {
  it('counts ranks from one, so the top hit of a list scores 1/(k+1)', () => {
    expect(reciprocalRank(0, RRF_CONSTANT)).toBeCloseTo(1 / 61, 10);
    expect(reciprocalRank(1, RRF_CONSTANT)).toBeCloseTo(1 / 62, 10);
  });
});

describe('RRF across ranked lists', () => {
  it('ranks an item both lists disagree about above one both rank second', () => {
    const fused = items([
      list('vector', [candidate('a'), candidate('b'), candidate('c')]),
      list('bm25', [candidate('c'), candidate('b'), candidate('a')]),
    ]);

    // a and c each score 1/61 + 1/63; b scores 2/62, which is lower.
    expect(ids(fused)).toEqual(['a', 'c', 'b']);
  });

  it('weights each leg by its configured share, so a vector-only hit outranks a bm25-only one', () => {
    const fused = items([
      list('vector', [candidate('v')], 0.4),
      list('bm25', [candidate('k', { method: 'bm25' })], 0.3),
    ]);

    expect(ids(fused)).toEqual(['v', 'k']);
    expect(fused[0]?.score).toBeCloseTo(0.4 / 61, 10);
    expect(fused[1]?.score).toBeCloseTo(0.3 / 61, 10);
  });

  it('keeps a contentless hit out of the pack without promoting what ranked under it', () => {
    const withGap = items([list('vector', [candidate('blank', { content: '   ' }), candidate('b')])]);
    const control = items([list('vector', [candidate('a'), candidate('b')])]);

    expect(ids(withGap)).toEqual(['b']);
    expect(withGap[0]?.score).toBeCloseTo(control[1]?.score ?? 0, 10);
  });
});

describe('the absolute cosine floor through fusion', () => {
  it('drops an item under the floor even though nothing else competes for the slot', () => {
    expect(
      items([list('vector', [candidate('weak', { relevance: 0.42 })])], {
        ...RRF,
        admission: CALIBRATED,
      }),
    ).toEqual([]);
  });

  it('measures the floor against retrieval scores, not the fused rank score', () => {
    const fused = items([list('vector', [candidate('strong', { relevance: 0.9 })])], {
      ...RRF,
      admission: CALIBRATED,
    });

    // The RRF score is ~0.016; a floor read against it would empty every pack.
    expect(fused[0]?.score).toBeLessThan(0.5);
    expect(ids(fused)).toEqual(['strong']);
  });

  it('measures each leg on its own, so one strong leg carries an item several legs found', () => {
    const fused = items(
      [
        list('vector', [candidate('both', { relevance: 0.6 })]),
        list('bm25', [candidate('both', { method: 'bm25', relevance: 0.2 })]),
      ],
      { ...RRF, admission: CALIBRATED },
    );

    expect(ids(fused)).toEqual(['both']);
    expect(fused[0]?.relevance).toBe(0.6);
  });
});

describe('traversal admission', () => {
  /** The gate-scale shape: a strong direct hit, plus a node only the spread reached. */
  function anchoredRun(anchorRelevance: number): readonly FusedItem[] {
    return items(
      [
        list('vector', [candidate('anchor', { relevance: anchorRelevance })]),
        list('graph_traversal', [
          candidate('anchor', { relevance: anchorRelevance }),
          candidate('reached', { method: 'activation', relevance: 0, activation: 0.29, evidence: [] }),
        ]),
      ],
      { ...RRF, admission: CALIBRATED },
    );
  }

  /**
   * The mechanism behind every budget-saturated off-topic pack the exercise measured: one
   * incidental hit cleared the floor and every node the spread had touched came with it. A
   * traversal-only node has no measurement against the query, so a strong anchor is not a
   * reason to serve it — and the anchor being strong is exactly when it used to be.
   */
  it('refuses a traversal-only node however strongly something else anchored the pack', () => {
    expect(ids(anchoredRun(0.9))).toEqual(['anchor']);
  });

  it('surfaces nothing when no hit cleared the floor, so traversal cannot fill an empty pack', () => {
    expect(anchoredRun(0.42)).toEqual([]);
  });

  it('admits a traversal-reached node that a retrieval leg also measured over the floor', () => {
    const fused = items(
      [
        list('vector', [
          candidate('anchor', { relevance: 0.9 }),
          candidate('reached', { relevance: 0.72 }),
        ]),
        list('graph_traversal', [
          candidate('reached', { method: 'activation', relevance: 0, activation: 0.29, evidence: [] }),
        ]),
      ],
      { ...RRF, admission: CALIBRATED },
    );

    expect(ids(fused)).toEqual(['reached', 'anchor']);
  });

  it('still drops a seed whose only strategy measured nothing', () => {
    const fused = items(
      [
        list('vector', [candidate('anchor', { relevance: 0.8 })]),
        list('graph_traversal', [
          candidate('anchor', { relevance: 0.8 }),
          candidate('recent', { method: 'recency', relevance: 0 }),
        ]),
      ],
      { ...RRF, admission: CALIBRATED },
    );

    expect(ids(fused)).toEqual(['anchor']);
  });
});

describe('the admission report', () => {
  it('names the floor it used and counts what it dropped', () => {
    const result = fuse(
      [
        list('vector', [
          candidate('kept', { relevance: 0.8 }),
          candidate('weak', { relevance: 0.3 }),
          candidate('twin', { relevance: 0.7, content: 'content of kept' }),
        ]),
        list('graph_traversal', [
          candidate('kept', { relevance: 0.8 }),
          candidate('reached', { method: 'activation', relevance: 0, activation: 0.2, evidence: [] }),
        ]),
      ],
      { ...RRF, admission: CALIBRATED },
    );

    expect(result.admission).toEqual({
      policy: CALIBRATED,
      considered: 4,
      admitted: 1,
      droppedBelowFloor: 1,
      droppedUnmeasured: 1,
      droppedDuplicateContent: 1,
      droppedNearDuplicate: 0,
      anchored: true,
    });
  });

  it('separates an empty substrate from a floor that rejected everything', () => {
    const empty = fuse([], { ...RRF, admission: CALIBRATED });
    const rejected = fuse([list('vector', [candidate('weak', { relevance: 0.2 })])], {
      ...RRF,
      admission: CALIBRATED,
    });

    expect(empty.admission.considered).toBe(0);
    expect(rejected.admission.considered).toBe(1);
    expect(rejected.admission.droppedBelowFloor).toBe(1);
    expect(rejected.admission.anchored).toBe(false);
  });

  it('counts a traversal-only candidate as unmeasured rather than as below the floor', () => {
    const result = fuse(
      [
        list('graph_traversal', [
          candidate('reached', { method: 'activation', relevance: 0, activation: 0.4, evidence: [] }),
        ]),
      ],
      { ...RRF, admission: CALIBRATED },
    );

    expect(result.items).toEqual([]);
    expect(result.admission.droppedUnmeasured).toBe(1);
    expect(result.admission.droppedBelowFloor).toBe(0);
  });
});
