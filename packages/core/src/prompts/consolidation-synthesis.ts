/**
 * The rollup and subject axes' synthesis prompts, and the reviewer that reads a draft against
 * the members it cites. Both axes render the same template the session narrative does, with the
 * opening naming what is being compressed.
 */

import { synthesisSystemPrompt } from './narrative-synthesis.js';
import type { RollupScope } from '../reflection/domain/rollup.js';

function synthesisPrompt(subject: string, sentenceBudget: number): string {
  return synthesisSystemPrompt({
    opening: `You compress ${subject} from a memory substrate into one durable memory.`,
    source: 'the members',
    noun: 'members',
    sentenceBudget,
  });
}

function scopeSubject(scope: RollupScope): string {
  return scope === 'day' ? "one day's session narratives" : "one week's daily narratives";
}

function rollup(scope: RollupScope, sentenceBudget: number): string {
  return synthesisPrompt(scopeSubject(scope), sentenceBudget);
}

function subjectAxis(sentenceBudget: number): string {
  return synthesisPrompt('several standing claims about one subject', sentenceBudget);
}

const REVIEW = [
  'You review a draft memory written from a numbered list of source members, and your job is to',
  'argue the other side.',
  'Each drafted sentence is followed by the tags of the members it cites. Read the sentence',
  'against those members only.',
  'Answer unsupported true the moment one sentence states a cause, an outcome, a quantity, a',
  'participant, a judgement or a certainty its own cited members do not state, naming the',
  'sentence and the addition in one line.',
  'Answer false only when every sentence stays inside what its citations say, however dull the',
  'result reads.',
].join(' ');

export const ROLLUP_LOCAL = rollup;
export const ROLLUP_KEYED = rollup;

export const SUBJECT_LOCAL = subjectAxis;
export const SUBJECT_KEYED = subjectAxis;

export const REVIEW_LOCAL = REVIEW;
export const REVIEW_KEYED = REVIEW;
