import type { SeedCandidate } from '../../infrastructure/graph/seed-queries.js';
import type { Vector } from '../../infrastructure/providers/types.js';
import { weightedMeanVector } from '../../reflection/domain/context-vector.js';
import type { FusedItem } from './fusion.js';

/**
 * The math behind context resonance, with no graph access: the centroid of an activated set's
 * context vectors, and the shape a hit against that centroid takes when it reaches the pack.
 *
 * A context vector is itself a strength-weighted mean of a node's neighbors' content vectors,
 * so the centroid is a mean of means: the aggregate relational neighborhood of everything the
 * first pass activated. What it measures is shape, never subject matter.
 */

/** How resonance explains itself in the pack, in place of the traversal path other methods print. */
export const RESONANCE_PATH = 'related by shape, not keywords';

/** One activated node as the centroid reads it: an id and the weight it carries. */
export type ActivationWeight = {
  readonly nodeId: string;
  readonly score: number;
};

/**
 * The activation-weighted mean of the context vectors of the activated set, and `undefined`
 * when the set cannot produce one: no activated node carries a context vector yet, every
 * activation score is zero, or the vectors disagree about their dimension.
 *
 * A node with no context vector contributes nothing rather than contributing a zero vector.
 * Reflection writes `context_vec` last, so on a young substrate most of the activated set has
 * none, and averaging a zero in for each of them would drag the centroid toward the origin and
 * make the whole second pass measure the gap in coverage instead of the shape of the thought.
 */
export function contextCentroid(
  activated: readonly ActivationWeight[],
  vectors: ReadonlyMap<string, Vector>,
): Vector | undefined {
  const entries: { vector: Vector; weight: number }[] = [];
  for (const node of activated) {
    const vector = vectors.get(node.nodeId);
    if (vector === undefined || vector.length === 0) {
      continue;
    }
    entries.push({ vector, weight: node.score });
  }
  const centroid = weightedMeanVector(entries);
  if (centroid === undefined) {
    return undefined;
  }
  return [...centroid];
}

/**
 * A resonant discovery as the pack holds it. Its measurement is the cosine between its own
 * context vector and the centroid, which is the only number about it that means anything: the
 * node was never measured against the query, and by construction its content may share nothing
 * with it.
 *
 * The fused score is that same similarity, so the resonant bucket is ordered by how strongly
 * each hit resonates. It is not comparable with a fused RRF score and never competes with one:
 * resonance runs beside fusion rather than inside it, and its items reach only their own bucket.
 */
export function resonantItem(candidate: SeedCandidate, similarity: number): FusedItem {
  return {
    id: candidate.id,
    labels: candidate.labels,
    content: candidate.content,
    ...(candidate.occurredAt === undefined ? {} : { occurredAt: candidate.occurredAt }),
    ...(candidate.sourceEpisodeId === undefined
      ? {}
      : { sourceEpisodeId: candidate.sourceEpisodeId }),
    ...(candidate.why === undefined ? {} : { why: candidate.why }),
    currency: candidate.currency,
    ...(candidate.supersededBy === undefined ? {} : { supersededBy: candidate.supersededBy }),
    rationale: { method: 'resonance', score: similarity, path: RESONANCE_PATH },
    relevance: similarity,
    evidence: [{ method: 'resonance', relevance: similarity }],
    score: similarity,
    measured: similarity,
  };
}
