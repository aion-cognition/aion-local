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

/**
 * The same four discriminations, each carried by one worked pair rather than by the general
 * statement of the shape. The small model reads the shared text as permission to answer true
 * whenever the two statements rhyme, and a rule it can match a pair against is what the general
 * wording does not give it. Same fields, same answer, and the closing instruction is the shared
 * text's word for word.
 */
const JUDGE_LOCAL = [
  'You judge whether a new statement contradicts an earlier one from the same memory substrate.',
  'They contradict only when both cannot hold at once, because the new statement reverses,',
  'replaces, or corrects the earlier one about the same subject.',
  'Different subjects: answer false. "The ledger service retries twice" beside "The intake',
  'service retries once" is two facts about two services, and both stay true.',
  'A restatement: answer false. "The sync job runs nightly" beside "The sync job runs nightly at',
  '2am" says one thing twice, one of them more precisely.',
  'Different times: answer false. "Tuesday\'s run took nine minutes" stays true after "The run',
  'takes four minutes" becomes the standing figure, because the record of one occasion does not',
  'claim to be the current state.',
  'Two people: answer false. "Ana argued for Postgres" beside "Ben argued for MySQL" is two',
  'positions, and neither makes the other untrue.',
  'Answer true only where you can name one attribute of one subject with an old value and a new',
  'value that cannot both be current: "The retry limit is three" beside "The retry limit is now',
  'five" is the retry limit with two rival values.',
  'Answer with contradicts, a confidence between 0 and 1 for how sure the pair makes you, and a',
  'one-clause rationale naming the subject both statements are about. Say false rather than guess.',
].join(' ');

export const LOCAL = JUDGE_LOCAL;
export const KEYED = JUDGE;
