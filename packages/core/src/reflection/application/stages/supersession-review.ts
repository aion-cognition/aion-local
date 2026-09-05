import { z } from 'zod';

import { deadlineFor } from '../../../infrastructure/providers/deadline-signal.js';
import type { ChatMessage, JsonSchema, Provider } from '../../../infrastructure/providers/types.js';
import { promptMode } from '../../../prompts/index.js';
import {
  KEYED as REVIEW_KEYED,
  LOCAL as REVIEW_LOCAL,
} from '../../../prompts/supersession-review.js';

/**
 * The second pass over an affirmative contradiction judgment, arguing the other side.
 *
 * It sees the same two statements and nothing else. The first pass's answer and rationale are
 * withheld on purpose: a reviewer shown the verdict it is reviewing agrees with it, and what
 * this call is worth is an independent reading of the same evidence.
 *
 * Two checks, both of which the closure has to survive. Survival asks whether the earlier
 * statement is actually made false, since an opinion, a wider scope, and a different attribute
 * of one subject all leave it standing. Well-formedness asks whether the newer statement is a
 * claim at all, since a garbled extraction and a mangled imperative can win a same-subject
 * comparison while asserting nothing a substrate can hold.
 */

/** Which check a veto failed. `unanswered` is a review that threw, timed out, or came back unusable. */
export type VetoCheck = 'survival' | 'well_formedness' | 'unanswered';

export type ReviewVerdict =
  | { readonly outcome: 'unanimous' }
  | { readonly outcome: 'vetoed'; readonly check: VetoCheck; readonly reason: string };

/**
 * `failed` is a call that threw or timed out, `unusable` an answer the schema refuses. Both
 * reach the caller as themselves rather than as a verdict, so a stage can log the difference
 * and a battery can count how often the reviewer answered at all.
 */
export type ReviewOutcome =
  | { readonly status: 'reviewed'; readonly verdict: ReviewVerdict }
  | { readonly status: 'failed'; readonly error: unknown }
  | { readonly status: 'unusable' };

export type ReviewPair = {
  readonly priorLabel: string;
  readonly currentLabel: string;
  readonly prior: string;
  readonly current: string;
  readonly sharedSubject?: string;
};

export type ReviewContradictionOptions = {
  readonly model: string;
  readonly timeoutMs: number;
  /** The caller's shutdown signal, composed under the call's own deadline. */
  readonly signal?: AbortSignal;
};

/**
 * `reason` is declared first because the model fills the fields in this order, and a reviewer
 * that has to name the replaced attribute and its two values before it answers gives a
 * different answer from one that answers first. With the booleans first, a first pass over the
 * 24-case battery affirmed all fourteen closures, including both known false positives.
 */
/**
 * Matches the first pass in `supersession-judge.ts`, and named rather than left to the route's
 * default, which the provider no longer sends. Unanimity is what closes a fact, and a sampled
 * reviewer turns that gate into a coin flip over evidence it already read.
 */
const REVIEW_TEMPERATURE = 0;

const REVIEW_JSON_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    reason: { type: 'string' },
    earlier_survives: { type: 'boolean' },
    newer_is_well_formed: { type: 'boolean' },
  },
  required: ['reason', 'earlier_survives', 'newer_is_well_formed'],
};

/** The reason is optional here and required in the JSON schema: a verdict without one is still usable. */
const ReviewSchema = z.object({
  earlier_survives: z.boolean(),
  newer_is_well_formed: z.boolean(),
  reason: z.string().optional(),
});

function buildReviewMessages(pair: ReviewPair, systemPrompt: string): ChatMessage[] {
  const subjectLine =
    pair.sharedSubject === undefined ? '' : `\n\nBoth statements name: ${pair.sharedSubject}`;
  return [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content:
        `Earlier statement (kind ${pair.priorLabel}):\n${pair.prior}\n\n` +
        `Newer statement (kind ${pair.currentLabel}):\n${pair.current}${subjectLine}`,
    },
  ];
}

const NO_REASON_GIVEN = 'the reviewer gave no reason';

/**
 * Well-formedness is named first when both checks fail: a newer statement that asserts nothing
 * cannot make anything false, so the survival question never arises for it.
 */
function toVerdict(parsed: z.infer<typeof ReviewSchema>): ReviewVerdict {
  const reason = parsed.reason?.trim();
  const stated = reason === undefined || reason.length === 0 ? NO_REASON_GIVEN : reason;
  if (!parsed.newer_is_well_formed) {
    return { outcome: 'vetoed', check: 'well_formedness', reason: stated };
  }
  if (parsed.earlier_survives) {
    return { outcome: 'vetoed', check: 'survival', reason: stated };
  }
  return { outcome: 'unanimous' };
}

/**
 * One review, prompt and schema included. Exported for the same reason the first pass is: a
 * battery that rebuilt the prompt would report a number for a reviewer the service does not run.
 */
export async function reviewContradiction(
  provider: Pick<Provider, 'generate' | 'route'>,
  pair: ReviewPair,
  options: ReviewContradictionOptions,
): Promise<ReviewOutcome> {
  const systemPrompt = promptMode(provider) === 'keyed' ? REVIEW_KEYED : REVIEW_LOCAL;
  const deadline = deadlineFor(options.timeoutMs, options.signal);
  let raw: unknown;
  try {
    raw = await provider.generate({
      model: options.model,
      messages: buildReviewMessages(pair, systemPrompt),
      schema: REVIEW_JSON_SCHEMA,
      temperature: REVIEW_TEMPERATURE,
      // Matches the first pass: reasoning buys nothing on a two-statement judgment and doubles
      // an already doubled budget.
      think: false,
      signal: deadline.signal,
    });
  } catch (error) {
    return { status: 'failed', error };
  } finally {
    deadline.clear();
  }

  const parsed = ReviewSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: 'unusable' };
  }
  return { status: 'reviewed', verdict: toVerdict(parsed.data) };
}

/**
 * The safe reading of a review that never arrived. A closure the substrate cannot defend is a
 * closure it does not make, so an unanswered second pass vetoes rather than waves through.
 */
export function vetoForUnansweredReview(detail: string): ReviewVerdict {
  return { outcome: 'vetoed', check: 'unanswered', reason: detail };
}

/** One line per outcome, for the proposal row a vetoed judgment leaves behind. */
export function describeVeto(verdict: ReviewVerdict): string {
  if (verdict.outcome === 'unanimous') {
    return 'unanimous';
  }
  return `vetoed on ${verdict.check}: ${verdict.reason}`;
}
