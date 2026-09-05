/** The one question the substrate stores for an entity it keeps seeing and cannot describe. */

const QUESTION = [
  'You write one question a personal memory system will put to its member later.',
  'You are given an entity the system keeps seeing and cannot describe, and episodes that',
  'mention it, most recent first.',
  'Write one plain question, a single sentence, that would get the member to say what this is',
  'and why it keeps coming up.',
  'Name the entity in the question. Whoever reads it will have none of this context, so a',
  'pronoun or a "this" resolves to nothing.',
  'Ask about what the episodes leave open; never assume a fact none of them state.',
].join(' ');

export const LOCAL = QUESTION;
export const KEYED = QUESTION;
