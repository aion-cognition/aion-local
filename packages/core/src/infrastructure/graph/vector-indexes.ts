/**
 * The names of the two vector indexes migration 001 declares on `:Memory`, in a module with no
 * imports of its own.
 *
 * They sit here rather than beside their readers because the readers now cross: the vector seed
 * leg searches both indexes, and resonance searches the context one, so a constant declared in
 * either reader's module puts a cycle through half of this directory. A node written without
 * the `Memory` label is invisible to both.
 */

/** Covers `content_vec`: what a node's own text is about. */
export const CONTENT_VECTOR_INDEX = 'content_vec_idx';

/** Covers `context_vec`: what a node's neighborhood is about. */
export const CONTEXT_VECTOR_INDEX = 'context_vec_idx';

/**
 * Neo4j reports cosine similarity rescaled onto [0,1] as `(1 + cos) / 2`, both from the vector
 * indexes and from `vector.similarity.cosine`, so two unrelated memories come back at 0.5
 * rather than 0. Every reader that compares a score against a cosine-scaled threshold converts
 * back with this first: read raw, a floor of 0.5 would admit every row the index returned.
 */
export function asCosine(scoreExpression: string): string {
  return `(2.0 * ${scoreExpression} - 1.0)`;
}

/**
 * The read-side half of `asCosine`, applied by every reader whose score reaches the domain as a
 * measurement rather than only as a comparison against a threshold.
 *
 * Neo4j scores in float32, so a node whose vector is the query vector comes back at
 * 1.0000001192092896 instead of 1, and the rescale above doubles the overshoot to
 * 1.0000002384185791. A cosine is at most 1 by definition, and a pack prints an admitted item's
 * measurement as a confidence the protocol bounds at 1, so the bound holds here rather than on
 * the accident that no cue ever embeds to exactly what a stored vector holds.
 *
 * One-sided: a genuinely negative cosine is a real reading and ranks below zero. Only the
 * ceiling is the arithmetic's to break.
 */
export function capScore(score: number): number {
  return Math.min(1, score);
}
