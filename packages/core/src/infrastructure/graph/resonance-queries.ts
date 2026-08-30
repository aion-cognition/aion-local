import type { Driver } from 'neo4j-driver';

import { runRead } from './connection.js';
import { CONTEXT_VECTOR_PROPERTY } from './context-vector-queries.js';
import { BASE_NODE_LABEL } from './labels.js';
import { readModeFragment, type ReadMode } from './read-modes.js';
import { fromGraphVector, toGraphInteger, toGraphVector } from './values.js';
import { asCosine, CONTEXT_VECTOR_INDEX } from './vector-indexes.js';
import type { Vector } from '../providers/types.js';

/**
 * The two reads context resonance makes: the activated set's context vectors, which the
 * centroid is the weighted mean of, and the second-pass search of the context vector index
 * with that centroid.
 *
 * Both live here rather than beside the content-vector reads in `seed-queries.ts` because
 * they ask about a different space. A content vector says what a node is about; a context
 * vector says what its neighborhood is about, and nothing that reasons about one is
 * transferable to the other.
 */

export { CONTEXT_VECTOR_INDEX } from './vector-indexes.js';

export type NodeContextVector = {
  readonly id: string;
  readonly vector: number[];
};

export type ContextVectorsInput = {
  readonly ids: readonly string[];
  readonly mode: ReadMode;
};

/**
 * Context embeddings for a set of ids, batched, the same shape and for the same reason as the
 * content-vector read: 768 floats per row is why recall asks for vectors where it needs them
 * rather than carrying them through the ordinary path.
 *
 * A row comes back only for a node that carries a context vector. An id missing from the
 * answer has not been through reflection's last stage yet, which is a normal state on a young
 * substrate and the one the caller reads as cold start.
 */
export async function contextVectors(
  driver: Driver,
  input: ContextVectorsInput,
): Promise<NodeContextVector[]> {
  if (input.ids.length === 0) {
    return [];
  }
  const fragment = readModeFragment(input.mode, 'n');
  const cypher = [
    'UNWIND $ids AS wantedId',
    `MATCH (n:${BASE_NODE_LABEL} { id: wantedId })`,
    `WHERE n.${CONTEXT_VECTOR_PROPERTY} IS NOT NULL AND ${fragment.where}`,
    `RETURN n.id AS id, n.${CONTEXT_VECTOR_PROPERTY} AS vector`,
  ].join('\n');

  return runRead(
    driver,
    cypher,
    { ...fragment.parameters, ids: [...new Set(input.ids)] },
    (row) => ({
      id: row.id as string,
      vector: fromGraphVector(row.vector) ?? [],
    }),
  );
}

export type ResonantHit = {
  readonly id: string;
  /** True cosine between the node's context vector and the centroid. */
  readonly similarity: number;
};

export type ResonantSearchInput = {
  /** The activation-weighted centroid of the activated set's context vectors. */
  readonly centroid: Vector;
  /** Minimum context similarity, `contextResonance.contextSearchThreshold`. */
  readonly threshold: number;
  /** How many hits the caller wants back, `contextResonance.resonantLimit`. */
  readonly limit: number;
  /** Everything the first pass already produced. A hit on one of these is not a discovery. */
  readonly exclude: ReadonlySet<string>;
  readonly mode: ReadMode;
};

/**
 * The second pass: nodes whose context vector sits near the centroid, ranked by that
 * similarity. Ids only, because the answer to "what is this node" already has one owner and
 * `nodeCandidates` is it; this query answers "which nodes resonate, and how strongly".
 *
 * `queryNodes` picks its k nearest before any predicate runs, so the exclusion set and the
 * read mode both filter the index's answer rather than its search. Every activated node is by
 * construction near the centroid of the activated set, so at `k = limit` the exclusion would
 * consume the whole result and the stage would return nothing on a healthy substrate. The
 * request is widened by the size of the exclusion set to leave room for the discoveries.
 */
export async function resonantNodes(
  driver: Driver,
  input: ResonantSearchInput,
): Promise<ResonantHit[]> {
  if (input.limit <= 0 || input.centroid.length === 0) {
    return [];
  }
  const fragment = readModeFragment(input.mode, 'n');
  const cypher = [
    'CALL db.index.vector.queryNodes($index, $k, $centroid) YIELD node AS n, score AS rescaled',
    `WITH n, ${asCosine('rescaled')} AS similarity`,
    `WHERE similarity >= $threshold AND NOT n.id IN $exclude AND ${fragment.where}`,
    'RETURN n.id AS id, similarity',
    'ORDER BY similarity DESC',
    'LIMIT $limit',
  ].join('\n');

  return runRead(
    driver,
    cypher,
    {
      ...fragment.parameters,
      index: CONTEXT_VECTOR_INDEX,
      k: toGraphInteger(input.limit + input.exclude.size),
      limit: toGraphInteger(input.limit),
      centroid: toGraphVector(input.centroid),
      threshold: input.threshold,
      exclude: [...input.exclude],
    },
    (row) => ({ id: row.id as string, similarity: row.similarity as number }),
  );
}
