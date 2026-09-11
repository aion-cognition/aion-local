import { describe, expect, it } from 'vitest';

import { evictionRelevance } from './episode-evict.js';
import { NEUTRAL_EVICTION_DEMAND, type EvictionDemand } from './health.js';

const MEASURED: EvictionDemand = {
  ...NEUTRAL_EVICTION_DEMAND,
  eligibleSources: 0,
  eligibleTurns: 0,
  estimatedBytes: 0,
  pendingSurvivorWork: 0,
  pendingRecovery: false,
  availability: 'measured',
};

describe('evictionRelevance', () => {
  it('scores one eligible source of a batch of eight as an eighth', () => {
    expect(evictionRelevance({ ...MEASURED, eligibleSources: 1 }, { batch: 8 })).toBeCloseTo(0.125);
  });

  it('never exceeds one however large the eligible population is', () => {
    expect(evictionRelevance({ ...MEASURED, eligibleSources: 400 }, { batch: 8 })).toBe(1);
  });

  it('stays selectable on zero fresh demand when a publication is still pending', () => {
    expect(evictionRelevance({ ...MEASURED, pendingRecovery: true }, { batch: 8 })).toBe(1);
  });

  it('stays selectable on zero fresh demand when a committed eviction owes survivor work', () => {
    expect(evictionRelevance({ ...MEASURED, pendingSurvivorWork: 3 }, { batch: 8 })).toBe(1);
  });

  it('reads known pending work off durable state even when the census failed', () => {
    expect(
      evictionRelevance({ ...NEUTRAL_EVICTION_DEMAND, pendingSurvivorWork: 1 }, { batch: 8 }),
    ).toBe(1);
  });

  it('scores an unavailable census zero rather than treating it as no work', () => {
    expect(evictionRelevance(NEUTRAL_EVICTION_DEMAND, { batch: 8 })).toBe(0);
  });

  it('scores a measured empty population zero', () => {
    expect(evictionRelevance(MEASURED, { batch: 8 })).toBe(0);
  });

  it('refuses to divide by a batch an operator turned off', () => {
    expect(evictionRelevance({ ...MEASURED, eligibleSources: 4 }, { batch: 0 })).toBe(0);
  });

  it('leaves qualification age out of the score', () => {
    const young = evictionRelevance(
      { ...MEASURED, eligibleSources: 2, oldestQualifiedAgeMs: 1 },
      { batch: 8 },
    );
    const old = evictionRelevance(
      { ...MEASURED, eligibleSources: 2, oldestQualifiedAgeMs: 86_400_000 * 90 },
      { batch: 8 },
    );
    expect(young).toBe(old);
  });
});
