import { describe, expect, it } from 'vitest';

import { cosineSimilarity } from './ranking.js';

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
