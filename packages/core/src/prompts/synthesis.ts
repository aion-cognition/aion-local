/** Drawing one conclusion across memories that no single memory states. */

/**
 * Three things this prompt has to hold.
 *
 * Conclusions distinct from evidence: a model asked to "synthesise" restates the longest input
 * memory and cites it, which writes a duplicate of a claim the substrate already holds. The ban
 * on restatement is stated as a rule and repeated as an instruction to answer with nothing.
 *
 * Prior readings as readings: a conclusion already drawn over these memories reaches the model
 * with the memories it rests on, and the prompt says so, because a model shown two readings of
 * one set of memories otherwise counts them as two witnesses and concludes that the substrate
 * agrees with itself.
 *
 * Three answers rather than one: the evidence decides whether a new reading revises the old one
 * or stands beside it, and a model given only "revise" will revise an unrelated claim to have
 * something to say. `alternative` is the answer for evidence that supports both, and an empty
 * list is the answer for evidence that supports neither.
 */
const SYNTHESIS = [
  'You draw conclusions across the memories of one personal memory substrate.',
  'You are given numbered memories, each tagged M1, M2 and so on, drawn from more than one',
  'episode, and sometimes conclusions already drawn over them, tagged C1, C2 and so on.',
  'A conclusion tagged C is a reading of the memories listed beside it, not a separate witness:',
  'never treat a C and the M memories under it as two pieces of evidence that agree.',
  'Answer only where the memories together state something none of them states alone.',
  'Three shapes qualify. A pattern: the same thing happening across memories, where the',
  'conclusion is what it happens for. A tension: two memories that cannot comfortably both be',
  'the whole story, where the conclusion is what that implies about the subject, such as what',
  'changed, what would cause it, or which of them holds. An open question: something the',
  'memories together raise and none of them answers.',
  'A conclusion is usually about the same subject its memories are about. What makes it a',
  'conclusion is that it says something none of them says, not that it changes the subject.',
  'Never restate, summarise or merge one memory: a conclusion that could be read off a single M',
  'is not a conclusion, and the right answer there is no conclusion at all.',
  'Cite in premises every memory tag the conclusion rests on, and cite no tag it does not.',
  'Set inference to "new" for a conclusion nothing already drawn covers.',
  'Set inference to "replaces" and revises to the C tag only when the new memories make that',
  'exact conclusion wrong about the same subject: the old reading stops being true.',
  'Set inference to "alternative" and revises to the C tag when the memories support both',
  'readings and you cannot tell which holds. Two readings that answer different questions are',
  'neither: they are two separate conclusions.',
  'Give confidence between 0 and 1 for how far the premises carry the conclusion, and a',
  'one-clause rationale naming what the memories have in common.',
  'Answer with an empty conclusions list rather than reach.',
].join(' ');

export const SYNTHESIS_PROMPT = SYNTHESIS;
