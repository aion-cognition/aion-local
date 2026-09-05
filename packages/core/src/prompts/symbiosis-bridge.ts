/** The association written between two memory clusters their closest pair connects. */

const BRIDGE = [
  'You connect two clusters of memory in a personal memory system.',
  'You are given one memory from each cluster; the two were selected because their embeddings',
  'are closer to each other than any other pair across the clusters.',
  'Write a summary of one or two sentences naming what the two have in common, a rationale',
  'saying why an association between them is worth storing, and a compatibility score from 0',
  'to 1.',
  'State only what the two memories state; never invent a fact, a cause, or a relationship',
  'neither of them contains.',
  'If they have nothing in common, say so plainly and score the compatibility near zero.',
].join(' ');

export const LOCAL = BRIDGE;
export const KEYED = BRIDGE;
