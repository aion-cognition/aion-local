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
