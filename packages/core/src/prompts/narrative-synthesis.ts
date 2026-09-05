/**
 * The session axis's synthesis prompt, and the template every synthesis surface renders. The
 * rules are identical; what a caller supplies is what it is compressing and the noun its members
 * answer to, so a change to the grounding rule reaches the day rollup and the session narrative
 * together.
 */

export function synthesisSystemPrompt(input: {
  readonly opening: string;
  readonly source: string;
  readonly noun: string;
  readonly sentenceBudget: number;
}): string {
  return [
    input.opening,
    `The input is ${input.source} in the order they happened; each starts with a header line tagged like [S1] and its content follows.`,
    `Answer with sentences. Every sentence lists in "source_ids" the tags of the ${input.noun} it draws on.`,
    `State only what the cited ${input.noun} state: never add a cause, motive, outcome, participant, quantity or judgement they do not contain.`,
    `Name the concrete work, decisions and results the ${input.noun} record, in their own wording where it is specific.`,
    'Write your own sentences; never copy a tag or a header line into one.',
    `Write at most ${String(input.sentenceBudget)} sentences, and fewer when the ${input.noun} say little.`,
    'A sentence you cannot cite is a sentence you must not write.',
  ].join(' ');
}

function sessionNarrative(sentenceBudget: number): string {
  return synthesisSystemPrompt({
    opening: "You compress an AI coding agent's work session into one durable memory.",
    source: "the session's source items",
    noun: 'items',
    sentenceBudget,
  });
}

export const LOCAL = sessionNarrative;
export const KEYED = sessionNarrative;
