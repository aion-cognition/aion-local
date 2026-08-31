import type { RecallMethod } from '@aion/protocol';
import { describe, expect, it } from 'vitest';

import type { AdmissionPolicy, Measurement, TypedInboundEvidence } from './admission.js';
import {
  fuse,
  reciprocalRank,
  withSoleMethod,
  type FusedItem,
  type FusionCandidate,
  type FusionOptions,
  type MethodLegStats,
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
  readonly typedEvidence?: TypedInboundEvidence;
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
    ...(overrides.typedEvidence === undefined ? {} : { typedEvidence: overrides.typedEvidence }),
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
    const withGap = items([
      list('vector', [candidate('blank', { content: '   ' }), candidate('b')]),
    ]);
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
  /**
   * The gate-scale shape: a strong direct hit, plus a node only the spread reached whose
   * content vector is still pending, so nothing measured it against the query.
   */
  function anchoredRun(anchorRelevance: number): readonly FusedItem[] {
    return items(
      [
        list('vector', [candidate('anchor', { relevance: anchorRelevance })]),
        list('graph_traversal', [
          candidate('anchor', { relevance: anchorRelevance }),
          candidate('reached', {
            method: 'activation',
            relevance: 0,
            activation: 0.29,
            evidence: [],
          }),
        ]),
      ],
      { ...RRF, admission: CALIBRATED },
    );
  }

  /** A node the spread reached, measured against one query cue at the given cosine. */
  function arrival(id: string, measured: number, activation = 0.29): FusionCandidate {
    return candidate(id, {
      method: 'activation',
      relevance: 0,
      activation,
      evidence: [{ method: 'vector', relevance: measured, cue: 'outbox table' }],
    });
  }

  /**
   * The mechanism behind every budget-saturated off-topic pack measured: one incidental hit
   * cleared the floor and every node the spread had touched came with it. Nothing measured
   * this one, so a strong anchor is not a reason to serve it, and the anchor being strong is
   * exactly when it used to be.
   */
  it('refuses an unmeasured node however strongly something else anchored the pack', () => {
    expect(ids(anchoredRun(0.9))).toEqual(['anchor']);
  });

  it('admits a node the spread reached when its own measurement clears the floor', () => {
    const fused = items(
      [
        list('vector', [candidate('anchor', { relevance: 0.9 })]),
        list('graph_traversal', [
          candidate('anchor', { relevance: 0.9 }),
          arrival('reached', 0.71),
        ]),
      ],
      { ...RRF, admission: CALIBRATED },
    );

    expect(ids(fused)).toEqual(['anchor', 'reached']);
    // Found by the spread, admitted on the cosine: the two are separate claims about it, and
    // the pack has to be able to say both.
    expect(fused[1]?.rationale.method).toBe('activation');
    expect(fused[1]?.measured).toBe(0.71);
  });

  it('refuses a node the spread reached whose measurement lands under the floor', () => {
    const fused = items(
      [
        list('vector', [candidate('anchor', { relevance: 0.9 })]),
        list('graph_traversal', [
          candidate('anchor', { relevance: 0.9 }),
          arrival('reached', 0.44),
        ]),
      ],
      { ...RRF, admission: CALIBRATED },
    );

    expect(ids(fused)).toEqual(['anchor']);
  });

  it('admits a node two cues corroborated sub-floor, the rule any seed gets', () => {
    const fused = items(
      [
        list('graph_traversal', [
          candidate('reached', {
            method: 'activation',
            relevance: 0,
            activation: 0.29,
            evidence: [
              { method: 'vector', relevance: 0.57, cue: 'outbox table' },
              { method: 'vector', relevance: 0.56, cue: 'remittance ingest' },
            ],
          }),
        ]),
      ],
      { ...RRF, admission: CALIBRATED },
    );

    expect(ids(fused)).toEqual(['reached']);
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
          candidate('reached', {
            method: 'activation',
            relevance: 0,
            activation: 0.29,
            evidence: [],
          }),
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

/** `CALIBRATED` with the typed tier on at a floor a full-strength one-hop CONTRADICTS clears. */
const TYPED_CALIBRATED: AdmissionPolicy = {
  ...CALIBRATED,
  typedAdmissionEnabled: true,
  typedAdmissionActivationFloor: 0.2,
};

describe('typed admission', () => {
  /** A CONTRADICTS-only arrival measured between the corroboration and vector floors. */
  function typedArrival(id: string, measured: number, contribution = 0.245): FusionCandidate {
    return candidate(id, {
      method: 'activation',
      relevance: 0,
      activation: 0.245,
      evidence: [{ method: 'vector', relevance: measured, cue: 'outbox table' }],
      typedEvidence: { edgeType: 'CONTRADICTS', contribution },
    });
  }

  it('admits on a CONTRADICTS partner a cosine alone would refuse', () => {
    const result = fuse([list('graph_traversal', [typedArrival('partner', 0.56)])], {
      ...RRF,
      admission: TYPED_CALIBRATED,
    });

    expect(ids(result.items)).toEqual(['partner']);
    expect(result.items[0]?.admittedBy).toEqual({
      rule: 'typed_admission',
      score: 0.56,
      qualifying: ['typed-edge: CONTRADICTS', 'vector 0.56'],
    });
    expect(result.admission.typedAdmitted).toBe(1);
    expect(result.admission.droppedBelowFloor).toBe(0);
  });

  it('refuses the same partner once the knob is off', () => {
    const result = fuse([list('graph_traversal', [typedArrival('partner', 0.56)])], {
      ...RRF,
      admission: CALIBRATED,
    });

    expect(ids(result.items)).toEqual([]);
    expect(result.admission.typedAdmitted).toBe(0);
    expect(result.admission.droppedBelowFloor).toBe(1);
  });

  it("refuses typed evidence too weak to clear the tier's own activation floor", () => {
    const result = fuse([list('graph_traversal', [typedArrival('partner', 0.56, 0.1)])], {
      ...RRF,
      admission: TYPED_CALIBRATED,
    });

    expect(ids(result.items)).toEqual([]);
    expect(result.admission.typedAdmitted).toBe(0);
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
          candidate('reached', {
            method: 'activation',
            relevance: 0,
            activation: 0.2,
            evidence: [],
          }),
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
      droppedUnmeasuredArrival: 1,
      droppedDuplicateContent: 1,
      droppedNearDuplicate: 0,
      anchored: true,
      typedAdmitted: 0,
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

  it('counts an arrival nothing could measure as unmeasured rather than as below the floor', () => {
    const result = fuse(
      [
        list('graph_traversal', [
          candidate('reached', {
            method: 'activation',
            relevance: 0,
            activation: 0.4,
            evidence: [],
          }),
        ]),
      ],
      { ...RRF, admission: CALIBRATED },
    );

    expect(result.items).toEqual([]);
    expect(result.admission.droppedUnmeasured).toBe(1);
    expect(result.admission.droppedUnmeasuredArrival).toBe(1);
    expect(result.admission.droppedBelowFloor).toBe(0);
  });

  /**
   * A recency seed and a plain BM25 seed are unmeasured by construction, so a caller reading
   * the whole unmeasured tally cannot tell ordinary lexical seeding from a traversal leg whose
   * every arrival is waiting on a vector. Only the arrival count answers that.
   */
  it('counts an unmeasured seed apart from an unmeasured arrival', () => {
    const result = fuse(
      [
        list('bm25', [candidate('lexical', { method: 'bm25', relevance: 0.9, evidence: [] })]),
        list('graph_traversal', [
          candidate('reached', {
            method: 'activation',
            relevance: 0,
            activation: 0.4,
            evidence: [],
          }),
        ]),
      ],
      { ...RRF, admission: CALIBRATED },
    );

    expect(result.admission.droppedUnmeasured).toBe(2);
    expect(result.admission.droppedUnmeasuredArrival).toBe(1);
  });

  /**
   * The two counters answer different questions, and a refusal only reads honestly when the
   * measured arrivals stop landing in the pending pile: this one was scored and fell short.
   */
  it('counts a measured arrival as below the floor rather than as unmeasured', () => {
    const result = fuse(
      [
        list('graph_traversal', [
          candidate('reached', {
            method: 'activation',
            relevance: 0,
            activation: 0.4,
            evidence: [{ method: 'vector', relevance: 0.38, cue: 'outbox table' }],
          }),
        ]),
      ],
      { ...RRF, admission: CALIBRATED },
    );

    expect(result.items).toEqual([]);
    expect(result.admission.droppedBelowFloor).toBe(1);
    expect(result.admission.droppedUnmeasured).toBe(0);
  });
});

/**
 * `methodStats` is instrumentation: it reports what already happened without moving anything.
 * Every case here reruns a fixture from above and checks that `items` (rank and score both)
 * comes back exactly as it did before this field existed, alongside the new counts.
 */
describe('the per-method leg stats', () => {
  it('counts a find no other leg made as sole, credited to the leg that made it', () => {
    const result = fuse([list('vector', [candidate('solo', { relevance: 0.8 })])], RRF);

    expect(ids(result.items)).toEqual(['solo']);
    expect(result.items[0]?.score).toBeCloseTo(reciprocalRank(0, RRF_CONSTANT), 10);
    expect(result.methodStats).toEqual({
      vector: { sole: 1, shared: 0, rrfContribution: reciprocalRank(0, RRF_CONSTANT) },
    });
  });

  it('credits every leg that found an item as shared, not only the one prefer explains it by', () => {
    // The exact fixture from "measures each leg on its own" above: two legs find the same
    // item, and `prefer` explains it as the vector hit because it scores higher.
    const result = fuse(
      [
        list('vector', [candidate('both', { relevance: 0.6 })]),
        list('bm25', [candidate('both', { method: 'bm25', relevance: 0.2 })]),
      ],
      { ...RRF, admission: CALIBRATED },
    );

    expect(ids(result.items)).toEqual(['both']);
    expect(result.items[0]?.rationale.method).toBe('vector');
    const contribution = reciprocalRank(0, RRF_CONSTANT);
    expect(result.methodStats).toEqual({
      vector: { sole: 0, shared: 1, rrfContribution: contribution },
      bm25: { sole: 0, shared: 1, rrfContribution: contribution },
    });
  });

  it('sums contribution across ranks rather than keeping only the strongest one', () => {
    // 'shared' ranks first in vector (found it) and second in bm25 (also found it, weaker);
    // both contributions belong to the two legs' own totals, and shared beats solo on score.
    const result = fuse(
      [
        list('vector', [candidate('shared', { relevance: 0.9 })]),
        list('bm25', [
          candidate('solo', { method: 'bm25', relevance: 0.5 }),
          candidate('shared', { method: 'bm25', relevance: 0.3 }),
        ]),
      ],
      RRF,
    );

    expect(ids(result.items)).toEqual(['shared', 'solo']);
    expect(result.methodStats.vector).toEqual({
      sole: 0,
      shared: 1,
      rrfContribution: reciprocalRank(0, RRF_CONSTANT),
    });
    expect(result.methodStats.bm25).toEqual({
      sole: 1,
      shared: 1,
      // bm25's own two contributions: rank 0 for 'solo', rank 1 for 'shared'.
      rrfContribution: reciprocalRank(0, RRF_CONSTANT) + reciprocalRank(1, RRF_CONSTANT),
    });
  });

  it('never counts a candidate the floor refused, so a thin pack reports no phantom finds', () => {
    const result = fuse([list('vector', [candidate('weak', { relevance: 0.2 })])], {
      ...RRF,
      admission: CALIBRATED,
    });

    expect(result.items).toEqual([]);
    expect(result.methodStats).toEqual({});
  });

  it('folds resonance in as a sole find with no RRF contribution of its own', () => {
    const withResonance = withSoleMethod(
      { vector: { sole: 1, shared: 0, rrfContribution: 0.5 } },
      'resonance',
      2,
    );

    expect(withResonance).toEqual({
      vector: { sole: 1, shared: 0, rrfContribution: 0.5 },
      resonance: { sole: 2, shared: 0, rrfContribution: 0 },
    });
  });

  it('leaves the stats untouched when there is nothing to fold in', () => {
    const stats: MethodLegStats = { vector: { sole: 1, shared: 0, rrfContribution: 0.5 } };

    expect(withSoleMethod(stats, 'resonance', 0)).toBe(stats);
  });
});

/**
 * The number an item prints has to be one the admitting rule read. A verbatim lexical hit
 * admits on evidence and measures nothing, so a weak cosine another leg happened to return
 * used to be printed in its place: a pack served an admitted item at 0.53 under a 0.55
 * corroboration floor and read as a gate with a hole in it.
 */
describe('what an admitted item reports as its measurement', () => {
  it('reports no measurement for a literal match, whatever else measured the item', () => {
    const fused = items(
      [
        list('bm25', [
          candidate('hit', {
            method: 'bm25',
            relevance: 1,
            evidence: [
              { method: 'bm25', relevance: 1, exact: true, cue: 'SQLITE_BUSY' },
              { method: 'vector', relevance: 0.53, cue: 'SQLITE_BUSY' },
            ],
          }),
        ]),
      ],
      { ...RRF, admission: CALIBRATED },
    );

    expect(ids(fused)).toEqual(['hit']);
    expect(fused[0]?.measured).toBe(0);
    expect(fused[0]?.admittedBy).toEqual({
      rule: 'exact_match',
      score: 0,
      qualifying: ['bm25 exact'],
    });
  });

  it('reports the cosine that cleared the floor and names the floor as the rule', () => {
    const fused = items([list('vector', [candidate('hit', { relevance: 0.72 })])], {
      ...RRF,
      admission: CALIBRATED,
    });

    expect(fused[0]?.measured).toBe(0.72);
    expect(fused[0]?.admittedBy?.rule).toBe('vector_floor');
  });

  it('reports the stronger of two corroborating cosines, both over the corroboration floor', () => {
    const fused = items(
      [
        list('vector', [
          candidate('hit', {
            relevance: 0.57,
            evidence: [
              { method: 'vector', relevance: 0.57, cue: 'outbox table' },
              { method: 'vector', relevance: 0.56, cue: 'remittance ingest' },
            ],
          }),
        ]),
      ],
      { ...RRF, admission: CALIBRATED },
    );

    expect(fused[0]?.measured).toBe(0.57);
    expect(fused[0]?.admittedBy?.qualifying).toEqual(['vector 0.57', 'vector 0.56']);
  });
});
