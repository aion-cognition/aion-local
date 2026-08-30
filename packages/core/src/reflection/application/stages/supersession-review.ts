import { z } from 'zod';

import type { ChatMessage, JsonSchema, Provider } from '../../../infrastructure/providers/types.js';

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
};

/**
 * `reason` is declared first because the model fills the fields in this order, and a reviewer
 * that has to name the replaced attribute and its two values before it answers gives a
 * different answer from one that answers first. With the booleans first, a first pass over the
 * 24-case battery affirmed all fourteen closures, including both known false positives.
 */
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

/**
 * Leads with the presumption that both statements stay, so the model has to be argued out of
 * that rather than into it, and puts the burden of proof on the closure: name one attribute of
 * the shared subject and two rival values for it, or the earlier statement stands. The first
 * pass carries the opposite lean, and the pair of them is what makes a unanimous answer worth
 * something.
 *
 * The four non-replacement shapes are the ones the measured false positives came in, stated
 * generally rather than as the cases that produced them.
 */
const REVIEW_SYSTEM_PROMPT = [
  'You decide one question: is the earlier statement, exactly as written, false now?',
  'Answer earlier_survives true unless it is. Two statements about one subject are usually both',
  'true, and the burden is on the replacement.',
  'Four rules make the earlier statement survive. Each is decisive on its own: where one',
  'applies, answer earlier_survives true and weigh nothing against it.',
  'One. The earlier statement records what a named person noted, wants, prefers, proposed, or',
  'argued. A record of a position is true from the moment it is made, and nothing later can',
  'falsify it: not another person taking the opposite position, and not a decision going the',
  'other way. This rule covers views only, and only two different people. A statement of how',
  'something is, who owns it, where it runs, or what it is set to is a state rather than a',
  'position, even where a person decided it, and a later state does replace it; and one person',
  'changing their own stated view replaces the earlier view.',
  'Two. The newer statement widens, extends, or adds to what the earlier one says, so the',
  'earlier case is still covered by it. Its own wording usually says so: not only X, as well as',
  'X, every X. Incomplete is not false: a statement that is still true but is no longer the',
  'whole picture survives, because the wider rule covers the narrow case it named.',
  'Three. The two statements describe different attributes of the subject, different',
  'environments, or one particular occasion set beside a standing rule. A record of one run,',
  'one measurement, or one meeting stays true after the thing it observed changes. A statement',
  'of how things stand carries no occasion, so a newer statement giving that standing value a',
  'different value replaces it and this rule does not apply.',
  'Four. The newer statement restates the earlier one, summarises it, or is merely more precise',
  'about it.',
  'Only where none of the four applies, and you can name one attribute of the subject with an',
  'old value and a rival new value that cannot both be current, is the earlier statement false.',
  'Separately, and whatever you answered above: is the newer statement a coherent, complete',
  'claim on its own? Answer newer_is_well_formed false when it is a garbled extraction, a',
  'fragment, an instruction with no subject, or a sentence that names things without asserting',
  'anything about them. A statement that asserts nothing replaces nothing, however close the',
  'wording.',
  'Keep reason to one sentence: name the rule that applies, or name the attribute and its two',
  'rival values.',
].join(' ');

function buildReviewMessages(pair: ReviewPair): ChatMessage[] {
  const subjectLine =
    pair.sharedSubject === undefined ? '' : `\n\nBoth statements name: ${pair.sharedSubject}`;
  return [
    { role: 'system', content: REVIEW_SYSTEM_PROMPT },
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
  provider: Pick<Provider, 'generate'>,
  pair: ReviewPair,
  options: ReviewContradictionOptions,
): Promise<ReviewOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, options.timeoutMs);
  let raw: unknown;
  try {
    raw = await provider.generate({
      model: options.model,
      messages: buildReviewMessages(pair),
      schema: REVIEW_JSON_SCHEMA,
      // Matches the first pass: reasoning buys nothing on a two-statement judgment and doubles
      // an already doubled budget.
      think: false,
      signal: controller.signal,
    });
  } catch (error) {
    return { status: 'failed', error };
  } finally {
    clearTimeout(timer);
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
