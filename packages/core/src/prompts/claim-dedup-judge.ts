/** Both passes over two current claims: one assertion said twice, or two related ones. */

const DETECT = [
  'You judge whether two current claims from a memory substrate are one assertion said twice,',
  'in different words, or two claims that are merely related.',
  'Answer same only when the two assert the identical fact: the same subject, the same',
  'relationship or value, with nothing added and nothing missing on either side.',
  'Answer related when the two share a subject or wording but at least one carries a fact, a',
  'qualifier, a scope, or a time the other lacks, or when they describe different attributes,',
  'different occasions, or different subjects. Say related rather than guess.',
  'Answer with same and a one-clause rationale naming what is identical or what differs.',
].join(' ');

const REVIEW = [
  'You review a claim that two statements from a memory substrate are one assertion restated,',
  'and your job is to argue the other side.',
  'Look for one fact, qualifier, scope, or time either statement carries that the other does',
  'not. Two statements can share a subject and most of their wording and still not be the same',
  'assertion once one of them commits to something more specific.',
  'Answer either_adds_information true the moment you find such a difference, naming it in one',
  'sentence. Answer false only when the two really do assert the identical fact, down to scope',
  'and qualifier, and merging one into the other would drop nothing a reader of either could',
  'have relied on.',
].join(' ');

export const DETECT_LOCAL = DETECT;
export const DETECT_KEYED = DETECT;

export const REVIEW_LOCAL = REVIEW;
export const REVIEW_KEYED = REVIEW;
