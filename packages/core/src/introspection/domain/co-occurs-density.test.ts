import { describe, expect, it } from 'vitest';

import {
  describeCoOccursDensity,
  summarizeCoOccursDensity,
  type CoOccursEpisodeObservation,
  type HubPenaltyObservation,
} from './co-occurs-density.js';

function episode(overrides: Partial<CoOccursEpisodeObservation> = {}): CoOccursEpisodeObservation {
  return {
    pairsProposed: 3,
    pairsWritten: 3,
    births: 3,
    recurrences: 0,
    birthStrength: 1 / 3,
    ...overrides,
  };
}

function walk(overrides: Partial<HubPenaltyObservation> = {}): HubPenaltyObservation {
  return { hops: 4, inhibitedHops: 1, totalPenalty: 3.5, minPenalty: 0.5, ...overrides };
}

describe('summarizeCoOccursDensity', () => {
  it('reports an empty population as zero, not as an absence', () => {
    const summary = summarizeCoOccursDensity([], []);

    expect(summary).toEqual({
      episodesObserved: 0,
      pairsProposed: 0,
      pairsWritten: 0,
      births: 0,
      recurrences: 0,
      birthStrengths: [],
      updateStrengths: [],
      recallWalksObserved: 0,
      totalHops: 0,
      inhibitedHops: 0,
      meanHubPenalty: undefined,
      minHubPenaltyObserved: undefined,
    });
  });

  it('sums births and recurrences across episodes, keeping a recurrence-only pass out of the birth sample', () => {
    const summary = summarizeCoOccursDensity(
      [
        episode({ births: 3, recurrences: 0, birthStrength: 1 / 3 }),
        episode({ pairsProposed: 1, pairsWritten: 1, births: 0, recurrences: 1, birthStrength: 1 }),
      ],
      [],
    );

    expect(summary.episodesObserved).toBe(2);
    expect(summary.pairsProposed).toBe(4);
    expect(summary.pairsWritten).toBe(4);
    expect(summary.births).toBe(3);
    expect(summary.recurrences).toBe(1);
    // The second episode bore nothing, so what it wrote is an update strength. Pooling it into
    // the birth sample reported a birth this substrate never had.
    expect(summary.birthStrengths).toEqual([1 / 3]);
    expect(summary.updateStrengths).toEqual([1]);
  });

  it('folds hub-inhibition walks, keeping the strongest (lowest) penalty ever observed', () => {
    const summary = summarizeCoOccursDensity(
      [],
      [
        walk({ hops: 4, inhibitedHops: 1, totalPenalty: 3.5, minPenalty: 0.5 }),
        walk({ hops: 2, inhibitedHops: 2, totalPenalty: 0.4, minPenalty: 0.1 }),
      ],
    );

    expect(summary.recallWalksObserved).toBe(2);
    expect(summary.totalHops).toBe(6);
    expect(summary.inhibitedHops).toBe(3);
    expect(summary.meanHubPenalty).toBeCloseTo(3.9 / 6);
    expect(summary.minHubPenaltyObserved).toBe(0.1);
  });

  it('reports no mean penalty when every walk evaluated zero hops', () => {
    const summary = summarizeCoOccursDensity(
      [],
      [walk({ hops: 0, inhibitedHops: 0, totalPenalty: 0, minPenalty: 1 })],
    );

    expect(summary.meanHubPenalty).toBeUndefined();
  });
});

describe('describeCoOccursDensity', () => {
  it('states both populations by name when both are present', () => {
    const lines = describeCoOccursDensity(summarizeCoOccursDensity([episode()], [walk()]));

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('1 sampled episode(s)');
    expect(lines[0]).toContain('3 first birth(s)');
    expect(lines[1]).toContain('1 sampled recall walk(s)');
    expect(lines[1]).toContain('1 hop(s) inhibited');
  });

  it('omits a population entirely rather than printing a line about nothing observed', () => {
    const lines = describeCoOccursDensity(summarizeCoOccursDensity([episode()], []));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('sampled episode');
  });

  it('reports no lines at all for a substrate with nothing observed yet', () => {
    expect(describeCoOccursDensity(summarizeCoOccursDensity([], []))).toEqual([]);
  });
});
