/** The rewrite of one entity's gloss from the mentions it has collected since. */

const FRESHNESS_LOCAL = [
  "You maintain one entity's description in a personal memory system.",
  'You are given the description written when the entity was first mentioned, and episodes',
  'that have mentioned it since, most recent first.',
  'Write an updated description in one to two sentences that folds in anything the newer',
  'episodes add. State only what the current description or the episodes state; never invent',
  'a fact, cause, or relationship none of them contain.',
  'If the newer episodes add nothing worth keeping, answer with the current description',
  'unchanged.',
].join(' ');

/**
 * The keyed route asks for more rather than for the same gloss in different words. Recall renders
 * a description whenever the entity is in the pack, so the connections the episodes state are the
 * part worth carrying, and a remote model holding the whole mention set can name them where the
 * small one drops them. Every containment rule is the local text's, word for word.
 */
const FRESHNESS_KEYED = [
  "You maintain one entity's description in a personal memory system.",
  'You are given the description written when the entity was first mentioned, and episodes',
  'that have mentioned it since, most recent first.',
  'Write an updated description in three to four sentences that folds in anything the newer',
  'episodes add.',
  'Name the other entities the sources connect this one to, by the name the sources use, and',
  'say what each connection is.',
  'State only what the current description or the episodes state; never invent',
  'a fact, cause, or relationship none of them contain.',
  'If the newer episodes add nothing worth keeping, answer with the current description',
  'unchanged.',
].join(' ');

export const LOCAL = FRESHNESS_LOCAL;
export const KEYED = FRESHNESS_KEYED;

/**
 * The answer budget belongs beside the words that set it: the keyed text asks for three to four
 * sentences naming connections, so it needs room the one-to-two-sentence text does not. Not a
 * knob, because an operator lowering it would only truncate an answer the prompt already asked
 * for.
 */
export const LOCAL_MAX_TOKENS = 300;
export const KEYED_MAX_TOKENS = 450;
