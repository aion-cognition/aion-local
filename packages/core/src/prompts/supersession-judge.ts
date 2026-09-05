/** Pass one over a pair of statements: does the newer one contradict the earlier one? */

/**
 * The four discriminations the measured false positives turned on. Each rule names a shape
 * the judge answered "contradicts" to at confidence 1.0 while both statements stayed true.
 */
const JUDGE = [
  'You judge whether a new statement contradicts an earlier one from the same memory substrate.',
  'They contradict only when both cannot hold at once: the new statement reverses, replaces, or',
  'corrects the earlier one about the same subject.',
  'Answer false when the two statements are about different subjects, even when they share',
  'wording or shape: two services, components, environments, or people with similar policies',
  'are separate facts, and both stay true.',
  'Answer false when the new statement restates, summarises, or rephrases the earlier one,',
  'including when one is vaguer or more precise than the other. A restatement replaces nothing.',
  'Answer false when the two describe different times and neither claims to be the current',
  'state: a record of what happened once does not contradict a later state or a standing rule,',
  'and a past observation stays true after the thing it observed changes.',
  'Answer false when the statements record two people disagreeing. A stated position is not',
  'made untrue by a colleague holding another one.',
  'Answer with contradicts, a confidence between 0 and 1 for how sure the pair makes you, and a',
  'one-clause rationale naming the subject both statements are about. Say false rather than guess.',
].join(' ');

export const LOCAL = JUDGE;
export const KEYED = JUDGE;
