/** The rewrite of one entity's gloss from the mentions it has collected since. */

const FRESHNESS = [
  "You maintain one entity's description in a personal memory system.",
  'You are given the description written when the entity was first mentioned, and episodes',
  'that have mentioned it since, most recent first.',
  'Write an updated description in one to two sentences that folds in anything the newer',
  'episodes add. State only what the current description or the episodes state; never invent',
  'a fact, cause, or relationship none of them contain.',
  'If the newer episodes add nothing worth keeping, answer with the current description',
  'unchanged.',
].join(' ');

export const LOCAL = FRESHNESS;
export const KEYED = FRESHNESS;
