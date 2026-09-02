import { describe, expect, it } from 'vitest';

import { pairwiseCosines } from './floor-calibration.js';
import type { Vector } from '../../infrastructure/providers/types.js';

/**
 * Hand-built vectors rather than embeddings: the claim is about which pairs the loop visits,
 * and a measured set would hide a missing half behind plausible numbers.
 *
 * Three basis vectors read against three sums of two, so every cross cosine is 0 or 1/sqrt(2)
 * and no transposed pair agrees with itself. cos(q0, c1) is 0 where cos(q1, c0) is 0.707.
 */
const QUERIES: readonly Vector[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

const CONTENTS: readonly Vector[] = [
  [1, 1, 0],
  [0, 1, 1],
  [1, 0, 1],
];

/** One spelling, so the cosine is symmetric and the pair set is unordered. */
const ONE_SPELLING: readonly Vector[] = [
  [1, 0],
  [1, 1],
  [0, 1],
];

const HALF = Number(Math.SQRT1_2.toFixed(6));

function rounded(scores: readonly number[]): number[] {
  return scores.map((score) => Number(score.toFixed(6)));
}

describe('pairwiseCosines over two spellings', () => {
  it('measures every ordered cross pair, not the i < j half', () => {
    const scores = pairwiseCosines(QUERIES, CONTENTS);

    expect(scores).toHaveLength(QUERIES.length * (CONTENTS.length - 1));
    expect(rounded(scores)).toEqual([0, HALF, HALF, 0, 0, HALF]);
  });

  it('reads a transposed pair as its own measurement', () => {
    const twoQueries = QUERIES.slice(0, 2);
    const twoContents = CONTENTS.slice(0, 2);

    // Cue 0 against content 1 scores nothing where cue 1 against content 0 scores 0.707. A
    // loop that only runs right > left keeps the first reading and drops the second.
    expect(rounded(pairwiseCosines(twoQueries, twoContents))).toEqual([0, HALF]);
  });

  it('refuses two arrays of different lengths, where index no longer names the diagonal', () => {
    expect(() => pairwiseCosines(QUERIES, CONTENTS.slice(0, 2))).toThrow(
      /same sentences in both spellings/,
    );
  });

  it('skips the diagonal, since a sentence against its own content is a related reading', () => {
    const scores = pairwiseCosines(QUERIES, [...QUERIES]);

    expect(scores).toHaveLength(6);
    expect(scores.every((score) => score === 0)).toBe(true);
  });
});

describe('pairwiseCosines over one spelling', () => {
  it('stays at the unordered pair count', () => {
    const scores = pairwiseCosines(ONE_SPELLING);

    expect(scores).toHaveLength(3);
    expect(rounded(scores)).toEqual([HALF, 0, HALF]);
  });

  it('reads the same array passed twice as one spelling', () => {
    expect(pairwiseCosines(ONE_SPELLING, ONE_SPELLING)).toEqual(pairwiseCosines(ONE_SPELLING));
  });
});
