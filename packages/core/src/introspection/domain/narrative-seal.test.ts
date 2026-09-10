import { describe, expect, it } from 'vitest';

import { NEUTRAL_SEAL_DEMAND, type SealDemand } from './health.js';
import { sealRelevance } from './narrative-seal.js';

/**
 * The demand score, on fixed readings. Nothing here reads a clock or a store: relevance is a
 * function of what the census said, and the point of these cases is which readings it refuses to
 * turn into urgency.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const SCALES = { batch: 2, ageScaleMs: DAY_MS };

function measured(overrides: Partial<SealDemand> = {}): SealDemand {
  return {
    ...NEUTRAL_SEAL_DEMAND,
    eligibleGroups: 0,
    dueRemainders: 0,
    dueChunks: 0,
    pendingPublishedRepair: false,
    availability: 'measured',
    diagnostic: undefined,
    ...overrides,
  };
}

describe('seal relevance', () => {
  it('is zero on a measured empty backlog', () => {
    expect(sealRelevance(measured(), SCALES)).toBe(0);
  });

  /**
   * Zero and unknown reach the same number by different routes, and the difference is what the
   * demand's own diagnostic carries. Scoring an unread census as work would run the operation on
   * a reading nobody took.
   */
  it('is zero on a census nobody could take, with nothing pending', () => {
    expect(sealRelevance(NEUTRAL_SEAL_DEMAND, SCALES)).toBe(0);
    expect(NEUTRAL_SEAL_DEMAND.availability).toBe('unavailable');
    expect(NEUTRAL_SEAL_DEMAND.eligibleGroups).toBeUndefined();
  });

  it('takes the count over the batch', () => {
    expect(sealRelevance(measured({ eligibleGroups: 1 }), SCALES)).toBe(0.5);
    expect(sealRelevance(measured({ eligibleGroups: 2 }), SCALES)).toBe(1);
    expect(sealRelevance(measured({ eligibleGroups: 40 }), SCALES)).toBe(1);
  });

  it('takes the age over the span where the age is the larger of the two', () => {
    const demand = measured({ eligibleGroups: 1, oldestEligibleAgeMs: DAY_MS * 0.75 });
    expect(sealRelevance(demand, SCALES)).toBe(0.75);
  });

  /**
   * A prepared publication nobody settled is the whole reading: while it stands the guard admits
   * no other, so every writer on the substrate is behind it, this operation included.
   */
  it('is one on a known pending publication, whatever the census said', () => {
    expect(sealRelevance(measured({ pendingPublishedRepair: true }), SCALES)).toBe(1);
    expect(sealRelevance({ ...NEUTRAL_SEAL_DEMAND, pendingPublishedRepair: true }, SCALES)).toBe(1);
  });

  it('refuses to divide by a scale that is not positive', () => {
    const demand = measured({ eligibleGroups: 5, oldestEligibleAgeMs: DAY_MS });
    expect(sealRelevance(demand, { batch: 0, ageScaleMs: DAY_MS })).toBe(0);
    expect(sealRelevance(demand, { batch: 2, ageScaleMs: 0 })).toBe(0);
  });
});
