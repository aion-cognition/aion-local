/**
 * Typed edges between the items two earlier stages extracted. The worked examples are here
 * because causality direction and CONTRADICTS were the two the small model got wrong without
 * them.
 */

const RELATIONSHIPS = [
  'You infer typed relationships between the entities and cognitive structures already',
  'extracted from one episode. Each item below carries a key; refer to items only by that',
  'key, never by its label, and never relate an item to itself.',
  'Use CAUSES when one item caused another and ENABLES when one item made another possible.',
  'For both, source is the cause and target is the effect. Re-read the quote and identify',
  'which item is the cause before you choose source and target; do not default to the order',
  'the items happen to appear in the episode text, and do not put the effect first because it',
  'was mentioned first. Example: the episode says "the shared transaction caused the',
  'deadlock", the transaction is the cause, so it is source, and the deadlock is the effect,',
  'so it is target, even though "deadlock" appears earlier in that sentence than "the shared',
  'transaction" did.',
  'Use PRECEDES when one item happened before another in a way that matters.',
  'Use CONTRADICTS only when the episode states an explicit contradiction: one item directly',
  "negates, rejects, or reverses the other in the episode's own words. Two items that agree,",
  'restate the same fact in different words, or are simply unrelated do not contradict. A',
  'reason for rejecting or choosing against something is not a contradiction with the thing',
  'itself, or with a restatement of the same reason. That is not a relationship this stage',
  'names at all, so leave it out rather than forcing it into CONTRADICTS. Example: the episode',
  'says "we rejected the queue tool because it is incompatible with our cache", the queue',
  'tool and the cache do not contradict each other, incompatibility between two tools is not',
  "one of this stage's types, so no relationship between them belongs in the answer at all.",
  'When unsure, do not use CONTRADICTS.',
  'Use SIMILAR when two items mean close to the same thing, RELATED_TO when two items are',
  'meaningfully connected but no other type fits, and ANALOGOUS_TO when two items are',
  'similar in kind without one causing, enabling, or preceding the other.',
  'For every relationship, quote the exact words from the episode that justify it: copy the',
  'span verbatim, do not paraphrase or summarize it. A relationship you cannot quote does not',
  'go in the answer.',
  'Give each relationship a confidence between 0 and 1 for how sure the episode makes you.',
  'Propose only relationships the episode actually supports; return an empty list rather than',
  'a weak guess.',
].join(' ');

export const LOCAL = RELATIONSHIPS;
export const KEYED = RELATIONSHIPS;
