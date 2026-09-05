import { z } from 'zod';

import { hashContent } from './content.js';
import {
  clip,
  groundSentences,
  narrativeSentenceBudget,
  renderItem,
  synthesisSystemPrompt,
  NARRATIVE_MAX_SENTENCES,
  type GroundedSentence,
  type NarrativeOutput,
  type NarrativeSource,
  type NarrativeSourceItem,
} from './narrative.js';
import type { RollupScope } from './rollup.js';
import type { ChatMessage, JsonSchema } from '../../infrastructure/providers/types.js';

/**
 * One engine, two axes. Compressing a day's narratives and compressing a subject's claims are
 * the same act: render the members with a tag each, ask for sentences that cite those tags,
 * keep only the sentences whose citations resolve, and let a second pass argue that a sentence
 * says more than what it cites. What differs between the axes is the member kind and the node
 * the answer is written to, which is the operation's business rather than this file's.
 *
 * Everything here is pure. The grounding rule, the review verdict, the derived ids, and the
 * density floor the subject axis reads off the live distribution are all assertable without a
 * graph or a model.
 */

export type ConsolidationMember = {
  readonly id: string;
  /** How the prompt names the member, lowercased: `narrative`, `decision`, `insight`. */
  readonly kind: string;
  readonly text: string;
  readonly occurredAt?: Date;
};

/**
 * The compression input, in the shape the narrative assembler already reads. Every member is
 * rendered, because a rollup that saw half its members would claim to cover a window it never
 * read; the batch that reaches here is bounded by the caller instead.
 */
export function renderConsolidationSource(
  members: readonly ConsolidationMember[],
  maxChars: number,
  maxSentences: number = NARRATIVE_MAX_SENTENCES,
): NarrativeSource {
  const items: NarrativeSourceItem[] = members.map((member, index) => ({
    handle: `S${String(index + 1)}`,
    id: member.id,
    kind: member.kind,
    text: clip(member.text, maxChars),
    ...(member.occurredAt === undefined ? {} : { occurredAt: member.occurredAt }),
  }));

  return {
    text: items.map(renderItem).join('\n\n'),
    items,
    renderedCount: items.length,
    coverage: members.length === 0 ? 0 : 1,
    sentenceBudget: narrativeSentenceBudget(items, maxSentences),
  };
}

/** Declared beside the grounding filter both axes run; re-exported here for its callers. */
export type { GroundedSentence };

export type GroundedConsolidation = {
  readonly sentences: readonly GroundedSentence[];
  /** The first grounded sentence, so the one line a pack shows is itself cited. */
  readonly summary: string;
  readonly narrative: string;
  /** Every cited id, in the order first cited. */
  readonly citations: readonly string[];
  readonly kept: number;
  readonly dropped: number;
};

/**
 * The same grounding filter the session axis runs, kept per sentence rather than folded into one
 * list: the review pass judges a sentence against the members that sentence cited, and a
 * node-level list cannot say which member was supposed to support which claim.
 */
export function assembleConsolidation(
  output: NarrativeOutput,
  source: NarrativeSource,
): GroundedConsolidation {
  const grounded = groundSentences(output, source);

  return {
    sentences: grounded.sentences,
    summary: grounded.sentences[0]?.text ?? '',
    narrative: grounded.sentences.map((sentence) => sentence.text).join(' '),
    citations: grounded.citations,
    kept: grounded.sentences.length,
    dropped: grounded.dropped,
  };
}

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

export function buildRollupMessages(source: NarrativeSource, scope: RollupScope): ChatMessage[] {
  return [
    { role: 'system', content: synthesisPrompt(scopeSubject(scope), source.sentenceBudget) },
    { role: 'user', content: `Members:\n${source.text}` },
  ];
}

export function buildSubjectMessages(source: NarrativeSource): ChatMessage[] {
  return [
    {
      role: 'system',
      content: synthesisPrompt('several standing claims about one subject', source.sentenceBudget),
    },
    { role: 'user', content: `Claims:\n${source.text}` },
  ];
}

const REVIEW_SYSTEM_PROMPT = [
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

const REVIEW_JSON_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    reason: { type: 'string' },
    unsupported: { type: 'boolean' },
  },
  required: ['reason', 'unsupported'],
};

const ReviewSchema = z.object({
  unsupported: z.boolean(),
  reason: z.string().optional(),
});

export const CONSOLIDATION_REVIEW_JSON_SCHEMA = REVIEW_JSON_SCHEMA;

const NO_REASON_GIVEN = 'the reviewer gave no reason';

export type ConsolidationReview =
  { readonly outcome: 'unanimous' } | { readonly outcome: 'vetoed'; readonly reason: string };

/** The tags of one sentence's citations, so the reviewer reads the same handles the draft did. */
function handlesFor(sentence: GroundedSentence, source: NarrativeSource): string {
  return source.items
    .filter((item) => sentence.citations.includes(item.id))
    .map((item) => item.handle)
    .join(', ');
}

export function buildConsolidationReviewMessages(
  source: NarrativeSource,
  draft: GroundedConsolidation,
): ChatMessage[] {
  const sentences = draft.sentences
    .map(
      (sentence, index) =>
        `${String(index + 1)}. ${sentence.text}\n   cites: ${handlesFor(sentence, source)}`,
    )
    .join('\n');
  return [
    { role: 'system', content: REVIEW_SYSTEM_PROMPT },
    { role: 'user', content: `Members:\n${source.text}\n\nDraft:\n${sentences}` },
  ];
}

/** `undefined` when the answer is in a shape the schema refuses, which the caller treats as a failure. */
export function readConsolidationReview(raw: unknown): ConsolidationReview | undefined {
  const parsed = ReviewSchema.safeParse(raw);
  if (!parsed.success) {
    return undefined;
  }
  if (!parsed.data.unsupported) {
    return { outcome: 'unanimous' };
  }
  const stated = parsed.data.reason?.trim();
  return {
    outcome: 'vetoed',
    reason: stated === undefined || stated.length === 0 ? NO_REASON_GIVEN : stated,
  };
}

/** Two members is the least that can be compressed: one claim consolidated is one claim copied. */
export const MIN_CONSOLIDATION_MEMBERS = 2;

/**
 * How many claims a neighbourhood needs before it is dense, read off the substrate's own
 * community sizes rather than picked. The reset made every hand-picked number moot, and a graph
 * whose communities all hold three claims has a different idea of dense from one whose
 * communities hold thirty.
 *
 * The upper quartile is the choice: it takes the neighbourhoods that stand out against this
 * substrate's own distribution, and it moves as the substrate grows. An empty distribution has
 * no floor to derive, which is what an operation with nothing to consolidate answers with.
 */
export function derivedDensityFloor(sizes: readonly number[]): number | undefined {
  const sorted = [...sizes].filter((size) => size > 0).sort((left, right) => left - right);
  if (sorted.length === 0) {
    return undefined;
  }
  const index = Math.max(0, Math.ceil(sorted.length * 0.75) - 1);
  return Math.max(MIN_CONSOLIDATION_MEMBERS, sorted[index] ?? MIN_CONSOLIDATION_MEMBERS);
}

/**
 * Derived from the window and the member set, never minted: a crash between the node write and
 * the supersession leaves the retry writing the same id, so a re-run matches the node it already
 * wrote instead of forking a second rollup for one window.
 */
export function rollupNodeId(scope: RollupScope, windowKey: string, coverageKey: string): string {
  return hashContent(['rollup', scope, windowKey, coverageKey]);
}

/**
 * The subject axis has no window to key on, so the member set is the identity: the same claims
 * consolidate to the same node id, which is what makes a second run over an unchanged set find
 * its own answer instead of writing another one.
 */
export function consolidationNodeId(coverageKey: string): string {
  return hashContent(['consolidation', coverageKey]);
}
