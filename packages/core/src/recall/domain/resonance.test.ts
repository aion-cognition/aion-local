import { MemoryPackSchema, type Cue, type StageTimingsMs } from '@aion/protocol';
import { describe, expect, it } from 'vitest';
import type { SeedCandidate } from '../../infrastructure/graph/seed-queries.js';
import type { Vector } from '../../infrastructure/providers/types.js';
import type { AdmissionReport } from './admission.js';
import { assemblePack, type BucketCaps } from './pack.js';
import { RESONANCE_PATH, contextCentroid, resonantItem } from './resonance.js';

const TIMINGS: StageTimingsMs = {
  embed: 12,
  cues: 340,
  seeds: 55,
  activation: 80,
  fusion: 4,
  resonance: 6,
};

const CUES: readonly Cue[] = [{ text: 'webhooks', source: 'query', weight: 3 }];

const CAPS: BucketCaps = { facts: 15, episodes: 5, narratives: 5, preferences: 3, resonant: 5 };

const ADMISSION: AdmissionReport = {
  policy: { vectorFloor: 0.6, corroborationFloor: 0.55, bm25Mode: 'exact' },
  considered: 4,
  admitted: 1,
  droppedBelowFloor: 3,
  droppedUnmeasured: 0,
  droppedUnmeasuredArrival: 0,
  droppedDuplicateContent: 0,
  droppedNearDuplicate: 0,
  anchored: true,
};

function candidate(id: string, content = `content of ${id}`, why?: string): SeedCandidate {
  return {
    id,
    labels: ['Episode', 'Memory', 'AionNode'],
    content,
    currency: 'current',
    ...(why === undefined ? {} : { why }),
  };
}

function vectors(entries: readonly [string, Vector][]): ReadonlyMap<string, Vector> {
  return new Map(entries);
}

describe('contextCentroid', () => {
  it('weights each context vector by the activation score behind it', () => {
    const centroid = contextCentroid(
      [
        { nodeId: 'a', score: 3 },
        { nodeId: 'b', score: 1 },
      ],
      vectors([
        ['a', [1, 0]],
        ['b', [0, 1]],
      ]),
    );

    // The plain mean would be [0.5, 0.5]; the strongly activated node pulls it three to one.
    expect(centroid?.[0]).toBeCloseTo(0.75, 10);
    expect(centroid?.[1]).toBeCloseTo(0.25, 10);
  });

  it('leaves an activated node with no context vector out of the mean entirely', () => {
    const withGap = contextCentroid(
      [
        { nodeId: 'a', score: 1 },
        { nodeId: 'unenriched', score: 1 },
      ],
      vectors([['a', [1, 0]]]),
    );

    // Not [0.5, 0], which is what averaging a zero vector in for the missing node would give:
    // the centroid would then measure how far enrichment has got rather than the shape.
    expect(withGap).toEqual([1, 0]);
  });

  it('returns the one vector it has when a single activated node carries one', () => {
    const centroid = contextCentroid([{ nodeId: 'a', score: 0.4 }], vectors([['a', [0.6, 0.8]]]));

    expect(centroid?.[0]).toBeCloseTo(0.6, 10);
    expect(centroid?.[1]).toBeCloseTo(0.8, 10);
  });

  it('has no centroid when nothing activated carries a context vector', () => {
    expect(contextCentroid([{ nodeId: 'a', score: 1 }], vectors([]))).toBeUndefined();
    expect(contextCentroid([], vectors([['a', [1, 0]]]))).toBeUndefined();
  });

  it('has no centroid when every activation score is zero, rather than dividing by zero', () => {
    expect(contextCentroid([{ nodeId: 'a', score: 0 }], vectors([['a', [1, 0]]]))).toBeUndefined();
  });
});

describe('a resonant discovery', () => {
  it('reports the context similarity as its measurement and says how it was found', () => {
    const found = resonantItem(candidate('r1'), 0.82);

    expect(found.rationale).toEqual({
      method: 'resonance',
      score: 0.82,
      path: RESONANCE_PATH,
    });
    expect(found.measured).toBe(0.82);
    expect(found.relevance).toBe(0.82);
    expect(found.evidence).toEqual([{ method: 'resonance', relevance: 0.82 }]);
  });

  it('carries the node\'s own reason through when the discovery has one', () => {
    const found = resonantItem(candidate('r1', undefined, 'shares the deploy-window subject'), 0.82);

    expect(found.why).toBe('shares the deploy-window subject');
  });

  it('lands in the resonant bucket rather than the one its labels would route it to', () => {
    const pack = assemblePack({
      items: [],
      admission: ADMISSION,
      caps: CAPS,
      tokenBudget: 1200,
      cues: CUES,
      timings: TIMINGS,
      resonant: [resonantItem(candidate('r1'), 0.82)],
    });

    expect(pack.resonant?.map((packed) => packed.id)).toEqual(['r1']);
    expect(pack.episodes).toBeUndefined();
    expect(pack.rendered_text).toContain('## Resonant');
    expect(pack.rendered_text).toContain(RESONANCE_PATH);
  });

  it('is ranked after everything the first pass admitted, whatever the two scores say', () => {
    const direct = {
      id: 'd1',
      labels: ['Episode', 'Memory', 'AionNode'],
      content: 'the direct answer',
      rationale: { method: 'vector' as const, score: 0.61 },
      relevance: 0.61,
      measured: 0.61,
      score: 0.02,
      currency: 'current' as const,
    };

    const pack = assemblePack({
      items: [direct],
      admission: ADMISSION,
      caps: CAPS,
      tokenBudget: 1200,
      cues: CUES,
      timings: TIMINGS,
      resonant: [resonantItem(candidate('r1'), 0.99)],
    });

    expect(pack.episodes?.[0]?.rank).toBe(1);
    expect(pack.resonant?.[0]?.rank).toBe(2);
  });

  it('is dropped when the first pass already packed the same memory under another id', () => {
    const direct = {
      id: 'd1',
      labels: ['Episode', 'Memory', 'AionNode'],
      content: 'the same memory, twice over',
      rationale: { method: 'vector' as const, score: 0.61 },
      relevance: 0.61,
      measured: 0.61,
      score: 0.02,
      currency: 'current' as const,
    };

    const pack = assemblePack({
      items: [direct],
      admission: ADMISSION,
      caps: CAPS,
      tokenBudget: 1200,
      cues: CUES,
      timings: TIMINGS,
      resonant: [resonantItem(candidate('r1', 'the same memory, twice over'), 0.9)],
    });

    expect(pack.resonant).toBeUndefined();
    expect(MemoryPackSchema.parse(pack).episodes).toHaveLength(1);
  });

  it('holds no more than the resonant cap allows', () => {
    const pack = assemblePack({
      items: [],
      admission: ADMISSION,
      caps: { ...CAPS, resonant: 2 },
      tokenBudget: 1200,
      cues: CUES,
      timings: TIMINGS,
      resonant: [
        resonantItem(candidate('r1'), 0.9),
        resonantItem(candidate('r2'), 0.85),
        resonantItem(candidate('r3'), 0.8),
      ],
    });

    expect(pack.resonant?.map((packed) => packed.id)).toEqual(['r1', 'r2']);
  });
});
