/** Reading how somebody likes to work off how they worked. */

/**
 * Three things this prompt has to hold.
 *
 * A preference is not a request: a model asked what somebody prefers will report the last thing
 * they asked for, which stores one task as a standing habit. The rule is stated as repetition
 * across the interaction, with an instruction to answer with nothing where there is only one
 * instance.
 *
 * A preference is not a quotation: the answer is a description of how the member works, in the
 * third person, because a first-person line reads back as something they said and the substrate
 * has no way to unsay it.
 *
 * Scope is asked for rather than assumed. Most of what an interaction shows is narrow, and a
 * narrow habit stored as a standing rule is served on every unrelated query afterwards, so a
 * contextual answer has to name the situation it holds in.
 */
const PREFERENCES = [
  'You read a working preference off one interaction with a personal memory substrate.',
  'You are given numbered lines tagged S1, S2 and so on, each with the transport role capture',
  'recorded, and sometimes preferences already held, tagged P1, P2 and so on.',
  'A role is a label the calling client set: it says a line was recorded, never who wrote it.',
  'Never treat a role as evidence about a person, and never answer with a preference read off',
  'a role alone.',
  'Answer only where the lines show a repeated way of working: something corrected more than',
  'once, asked for more than once, or done the same way each time.',
  'A single request is a request and not a preference. Answer with nothing for one instance.',
  'Write each preference in the third person as a description of how the member works, never as',
  'a sentence they said and never in their voice.',
  'Cite in grounds every line tag the preference rests on, and cite no tag it does not.',
  'Set scope to "standing" only for a way of working the lines show outside any one task.',
  'Set scope to "contextual" otherwise, and name the situation it holds in under context.',
  'Set revises to a P tag only when the new lines show the held preference is now wrong: the',
  'member works another way. Refining or narrowing a held preference is a revision of it.',
  'Give confidence between 0 and 1 for how far the lines carry the preference.',
  'Answer with an empty preferences list rather than reach.',
].join(' ');

export const PREFERENCES_PROMPT = PREFERENCES;
