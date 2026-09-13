/** The rewrite of one entity's gloss from the mentions it has collected since. */

/**
 * It asks for the connections as well as the gloss. Recall renders a description whenever the
 * entity is in the pack, so the relationships the episodes state are the part worth carrying, and
 * a model holding the whole mention set can name them.
 *
 * A second, shorter text stood beside this one until the local generation route was removed. It
 * asked for one to two sentences and named no connections, and nothing could reach it: every
 * provider the service builds routes to the one remote model.
 */
const FRESHNESS = [
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

export const FRESHNESS_PROMPT = FRESHNESS;

/**
 * The answer budget belongs beside the words that set it: the text asks for three to four
 * sentences naming connections, so it needs the room for one. Not a knob, because an operator
 * lowering it would only truncate an answer the prompt already asked for.
 */
export const MAX_TOKENS = 450;
