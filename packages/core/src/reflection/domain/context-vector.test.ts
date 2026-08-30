import { describe, expect, it } from 'vitest';

import { computeContextVectors, weightedMeanVector } from './context-vector.js';

describe('weightedMeanVector', () => {
  it('returns undefined for no entries', () => {
    expect(weightedMeanVector([])).toBeUndefined();
  });

  it('returns the single neighbor vector, whatever its weight', () => {
    const scaled = weightedMeanVector([{ vector: [1, 2, 3], weight: 0.4 }]);
    expect(scaled?.[0]).toBeCloseTo(1, 10);
    expect(scaled?.[1]).toBeCloseTo(2, 10);
    expect(scaled?.[2]).toBeCloseTo(3, 10);
    // Weight 1 divides out exactly, with no floating-point rounding at all.
    expect(weightedMeanVector([{ vector: [1, 2, 3], weight: 1 }])).toEqual([1, 2, 3]);
  });

  it('weights a stronger neighbor more heavily than an equal-count simple average would', () => {
    const mean = weightedMeanVector([
      { vector: [0, 0], weight: 0.1 },
      { vector: [10, 10], weight: 0.9 },
    ]);
    // Simple average would land at [5, 5]; the strong edge pulls it toward [10, 10].
    expect(mean?.[0]).toBeCloseTo(9, 5);
    expect(mean?.[1]).toBeCloseTo(9, 5);
  });

  it('recovers the plain average when every weight is equal', () => {
    const mean = weightedMeanVector([
      { vector: [2, 4], weight: 0.5 },
      { vector: [4, 8], weight: 0.5 },
    ]);
    expect(mean?.[0]).toBeCloseTo(3, 5);
    expect(mean?.[1]).toBeCloseTo(6, 5);
  });

  it('skips zero and negative weight entries rather than letting them dilute the mean', () => {
    const mean = weightedMeanVector([
      { vector: [100, 100], weight: 0 },
      { vector: [2, 2], weight: 1 },
    ]);
    expect(mean).toEqual([2, 2]);
  });

  it('returns undefined when every entry is zero-weighted: no vectored neighbor really contributed', () => {
    expect(
      weightedMeanVector([
        { vector: [1, 1], weight: 0 },
        { vector: [2, 2], weight: 0 },
      ]),
    ).toBeUndefined();
  });

  it('drops an entry whose dimension does not match the rest rather than corrupting the sum', () => {
    const mean = weightedMeanVector([
      { vector: [1, 1, 1], weight: 1 },
      { vector: [9, 9], weight: 1 },
    ]);
    expect(mean).toEqual([1, 1, 1]);
  });
});

describe('computeContextVectors', () => {
  it('skips a node with zero rows: it never appears in the input', () => {
    expect(computeContextVectors([])).toEqual([]);
  });

  it('groups rows by affected node and computes one mean per node', () => {
    const results = computeContextVectors([
      { nodeId: 'a', neighborId: 'x', strength: 1, vector: [1, 0] },
      { nodeId: 'a', neighborId: 'y', strength: 1, vector: [0, 1] },
      { nodeId: 'b', neighborId: 'x', strength: 1, vector: [1, 0] },
    ]);

    const byId = new Map(results.map((r) => [r.id, r]));
    expect(byId.get('a')?.vector[0]).toBeCloseTo(0.5, 5);
    expect(byId.get('a')?.vector[1]).toBeCloseTo(0.5, 5);
    expect(byId.get('a')?.neighborCount).toBe(2);
    expect(byId.get('b')?.vector).toEqual([1, 0]);
  });

  it('lets a doubly-connected neighbor (two edges to the same pair) count twice', () => {
    const results = computeContextVectors([
      { nodeId: 'a', neighborId: 'x', strength: 1, vector: [10, 0] },
      { nodeId: 'a', neighborId: 'x', strength: 1, vector: [10, 0] },
      { nodeId: 'a', neighborId: 'y', strength: 1, vector: [0, 10] },
    ]);
    const a = results.find((r) => r.id === 'a');
    // x's two edges outweigh y's one: the mean leans toward x, not a 50/50 split.
    expect(a?.vector[0]).toBeGreaterThan(a?.vector[1] ?? 0);
  });

  it('drops a node whose only neighbor rows are zero-weighted, cleanly', () => {
    const results = computeContextVectors([
      { nodeId: 'a', neighborId: 'x', strength: 0, vector: [1, 1] },
    ]);
    expect(results).toEqual([]);
  });
});
