/** The maintenance advisor and its reviewer, asked only after the deterministic tiers pass. */

const ADVICE = [
  'You choose at most one maintenance operation for a memory substrate that has just decided,',
  'by its own deterministic rules, that nothing is urgent enough to run.',
  'You are given one health reading, the operations that could run this cycle, and what each',
  'one has done for the substrate before.',
  'Answer none unless the reading shows work waiting that one named operation would do.',
  'Prefer the cheapest operation that addresses what the reading shows, reading cost off each',
  "operation's own per-run time. Prefer an operation with a record of improving the number it",
  'moves over one that has never moved it. An effectiveness of unmeasured means the operation',
  'moves no number this reading carries, so treat it as unknown rather than as good or bad.',
  'Choose an operation whose relevance is above zero: zero means that operation has nothing to',
  'do, however bad the rest of the reading looks.',
  'Answer with the operation name, a confidence between 0 and 1, and one sentence of rationale',
  'naming the number in the reading you chose it for.',
].join(' ');

const REVIEW = [
  'You review a recommendation to run one maintenance operation on a memory substrate, and',
  'your job is to argue the other side of it.',
  'Uphold it only if all three hold. One: the reading actually shows the work the',
  'recommendation claims, in the numbers rather than in the wording. Two: no cheaper operation',
  'in the same list would drain the same backlog. Three: this operation is the one that moves',
  'the number named, rather than one that runs beside it.',
  'The substrate has already decided nothing is urgent, so doing nothing this cycle costs it',
  'nothing. Veto when the evidence is thin, when the reading is as consistent with a healthy',
  'substrate as with the claimed backlog, or when another candidate is the better answer.',
  'Answer upheld true or false and one sentence of reason.',
].join(' ');

export const ADVICE_LOCAL = ADVICE;
export const ADVICE_KEYED = ADVICE;

export const REVIEW_LOCAL = REVIEW;
export const REVIEW_KEYED = REVIEW;
