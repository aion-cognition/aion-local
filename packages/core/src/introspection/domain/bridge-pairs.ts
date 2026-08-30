import type {
  CommunityPairEdges,
  CommunityProfile,
} from '../../infrastructure/graph/community-queries.js';

/**
 * Which two neighbourhoods a bridge should join, decided from the graph's own shape and
 * nothing else.
 *
 * The engine used to take the two least connected communities, which reads as the right answer
 * and is not: least connected orders one community at a time, and a bridge is about a pair.
 * Two lonely communities can be lonely for unrelated reasons, and joining them writes an edge
 * between things that have nothing to do with each other, which is the noise a bridge is
 * supposed to be the opposite of.
 *
 * Four terms, each on 0 to 1, multiplied. A pair scores well only when all four hold, which is
 * the property a product has and a weighted sum does not: one strong term cannot carry a pair
 * that fails on another.
 */

export type CommunityPairScore = {
  readonly left: CommunityProfile;
  readonly right: CommunityProfile;
  /** How much holds the two communities together internally, the weaker side deciding. */
  readonly coherence: number;
  /** The smaller community over the larger: a bridge between a neighbourhood and a pair is one-sided. */
  readonly sizeBalance: number;
  /** Edges already crossing between the two, over the smaller community's size. */
  readonly overlap: number;
  /** How cut off the pair is from the rest of the graph, which is what a bridge is for. */
  readonly isolation: number;
  readonly score: number;
};

export type RankCommunityPairsInput = {
  readonly profiles: readonly CommunityProfile[];
  readonly pairEdges: readonly CommunityPairEdges[];
  /** Above this share of shared structure the pair is already connected and is skipped. */
  readonly overlapCeiling: number;
};

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Association edges per member, capped: one edge each is already a connected neighbourhood. */
export function communityCoherence(profile: CommunityProfile): number {
  if (profile.size <= 0) {
    return 0;
  }
  return clamp(profile.internalEdges / profile.size);
}

/** Falls as a community's outside edges approach one per member. */
export function communityIsolation(profile: CommunityProfile): number {
  if (profile.size <= 0) {
    return 0;
  }
  return clamp(1 - profile.externalEdges / profile.size);
}

function pairKey(left: number, right: number): string {
  const [low, high] = left < right ? [left, right] : [right, left];
  return `${String(low)}:${String(high)}`;
}

/**
 * The pair is canonicalised on the community ids, lower first. Every term is symmetric, so the
 * order carries no meaning of its own, and fixing it is what makes the bridge's stored source
 * and target the same two properties whichever order the profiles arrived in.
 */
export function scoreCommunityPair(
  first: CommunityProfile,
  second: CommunityProfile,
  crossingEdges: number,
): CommunityPairScore {
  const [left, right] =
    first.community <= second.community ? [first, second] : [second, first];
  const coherence = Math.min(communityCoherence(left), communityCoherence(right));
  const smaller = Math.min(left.size, right.size);
  const larger = Math.max(left.size, right.size);
  const sizeBalance = larger <= 0 ? 0 : smaller / larger;
  const overlap = smaller <= 0 ? 1 : clamp(crossingEdges / smaller);
  const isolation = Math.min(communityIsolation(left), communityIsolation(right));
  return {
    left,
    right,
    coherence,
    sizeBalance,
    overlap,
    isolation,
    score: coherence * sizeBalance * (1 - overlap) * isolation,
  };
}

/**
 * Every pair worth considering, best first. Pairs over the overlap ceiling are dropped rather
 * than ranked low: they are already joined, and a bridge across them is a write that buys
 * spreading activation nothing.
 *
 * Ties break on the community ids, so two pairs the graph cannot separate are not separated by
 * the order the profiles happened to arrive in.
 */
export function rankCommunityPairs(
  input: RankCommunityPairsInput,
): readonly CommunityPairScore[] {
  const crossing = new Map(
    input.pairEdges.map((pair) => [pairKey(pair.left, pair.right), pair.edges]),
  );
  const scored: CommunityPairScore[] = [];
  for (let i = 0; i < input.profiles.length; i += 1) {
    for (let j = i + 1; j < input.profiles.length; j += 1) {
      const left = input.profiles[i];
      const right = input.profiles[j];
      if (left === undefined || right === undefined) {
        continue;
      }
      const edges = crossing.get(pairKey(left.community, right.community)) ?? 0;
      const pair = scoreCommunityPair(left, right, edges);
      if (pair.overlap > input.overlapCeiling || pair.score <= 0) {
        continue;
      }
      scored.push(pair);
    }
  }
  return scored.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    if (a.left.community !== b.left.community) {
      return a.left.community - b.left.community;
    }
    return a.right.community - b.right.community;
  });
}
