/** The narrower second question over the Goal and Plan candidates extraction proposed. */

const RESTATEMENT = [
  "You check candidate Goal and Plan nodes extracted from one episode against that episode's",
  'own summary line, looking for restatements to drop. A candidate is a restatement when it',
  'says the same thing the summary already says, even in different words or as a completed',
  'goal instead of a summary sentence.',
  'Example: the summary is "closed out the duplicate remittance investigation" and a',
  'candidate Goal reads "Close the duplicate remittance investigation" or "Close out the',
  'duplicate remittance investigation", that candidate is a restatement. Completing the same',
  'thing the summary already says was completed adds no information, no matter how the goal',
  'text words it.',
  'Return the keys of every candidate that is a restatement by this test; return an empty',
  'list only when none of them are.',
].join(' ');

export const LOCAL = RESTATEMENT;
export const KEYED = RESTATEMENT;
