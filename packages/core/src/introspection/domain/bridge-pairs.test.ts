import { describe, expect, it } from 'vitest';

import {
  communityCoherence,
  communityIsolation,
  rankCommunityPairs,
  scoreCommunityPair,
} from './bridge-pairs.js';
import type { CommunityProfile } from '../../infrastructure/graph/community-queries.js';

function profile(overrides: Partial<CommunityProfile> & { community: number }): CommunityProfile {
  return { size: 10, externalEdges: 0, internalEdges: 10, ...overrides };
}

describe('community terms', () => {
  it('reads coherence as association edges per member, capped at one', () => {
    expect(communityCoherence(profile({ community: 1, size: 10, internalEdges: 5 }))).toBeCloseTo(
      0.5,
    );
    expect(communityCoherence(profile({ community: 1, size: 10, internalEdges: 40 }))).toBe(1);
    expect(communityCoherence(profile({ community: 1, size: 0, internalEdges: 0 }))).toBe(0);
  });

  it('reads isolation as the absence of edges leaving the community', () => {
    expect(communityIsolation(profile({ community: 1, size: 10, externalEdges: 0 }))).toBe(1);
    expect(communityIsolation(profile({ community: 1, size: 10, externalEdges: 3 }))).toBeCloseTo(
      0.7,
    );
    expect(communityIsolation(profile({ community: 1, size: 10, externalEdges: 40 }))).toBe(0);
  });
});

describe('scoreCommunityPair', () => {
  it('takes the weaker side on coherence and isolation', () => {
    const strong = profile({ community: 1, size: 10, internalEdges: 10, externalEdges: 0 });
    const weak = profile({ community: 2, size: 10, internalEdges: 2, externalEdges: 5 });

    const pair = scoreCommunityPair(strong, weak, 0);
    expect(pair.coherence).toBeCloseTo(0.2);
    expect(pair.isolation).toBeCloseTo(0.5);
  });

  it('scores a lopsided pair below an even one with the same edges', () => {
    const big = profile({ community: 1, size: 40 });
    const small = profile({ community: 2, size: 4, internalEdges: 4 });
    const even = profile({ community: 3, size: 40 });

    expect(scoreCommunityPair(big, small, 0).score).toBeLessThan(
      scoreCommunityPair(big, even, 0).score,
    );
  });
});

describe('rankCommunityPairs', () => {
  const isolated = profile({ community: 1, size: 10, internalEdges: 10, externalEdges: 0 });
  const alsoIsolated = profile({ community: 2, size: 10, internalEdges: 10, externalEdges: 0 });
  const loose = profile({ community: 3, size: 10, internalEdges: 2, externalEdges: 6 });

  it('drops a pair that already shares more structure than the ceiling allows', () => {
    const ranked = rankCommunityPairs({
      profiles: [isolated, alsoIsolated],
      pairEdges: [{ left: 1, right: 2, edges: 4 }],
      overlapCeiling: 0.25,
    });

    expect(ranked).toEqual([]);
  });

  it('keeps a pair joined by a thread', () => {
    const ranked = rankCommunityPairs({
      profiles: [isolated, alsoIsolated],
      pairEdges: [{ left: 1, right: 2, edges: 1 }],
      overlapCeiling: 0.25,
    });

    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.overlap).toBeCloseTo(0.1);
  });

  /**
   * The behaviour the old engine could not have: it took the two least connected communities,
   * one at a time, so a pair of coherent neighbourhoods lost to whichever single community
   * happened to have the fewest outside edges.
   */
  it('prefers two coherent neighbourhoods over a loose one that is merely lonely', () => {
    const ranked = rankCommunityPairs({
      profiles: [isolated, alsoIsolated, loose],
      pairEdges: [],
      overlapCeiling: 0.25,
    });

    expect(ranked[0]?.left.community).toBe(1);
    expect(ranked[0]?.right.community).toBe(2);
  });

  it('breaks a tie on the community ids rather than on arrival order', () => {
    const third = profile({ community: 3, size: 10, internalEdges: 10, externalEdges: 0 });
    const ranked = rankCommunityPairs({
      profiles: [third, alsoIsolated, isolated],
      pairEdges: [],
      overlapCeiling: 0.25,
    });

    expect(ranked.map((pair) => [pair.left.community, pair.right.community])).toEqual([
      [1, 2],
      [1, 3],
      [2, 3],
    ]);
  });

  it('drops a pair that scores zero rather than ranking it last', () => {
    const bare = profile({ community: 4, size: 10, internalEdges: 0, externalEdges: 0 });
    const ranked = rankCommunityPairs({
      profiles: [bare, isolated],
      pairEdges: [],
      overlapCeiling: 0.25,
    });

    expect(ranked).toEqual([]);
  });
});
