import { z } from 'zod';

import { errorMessage } from '../../infrastructure/errors.js';
import { deadlineFor } from '../../infrastructure/providers/deadline-signal.js';
import type { ChatMessage, JsonSchema, Provider } from '../../infrastructure/providers/types.js';
import {
  DETECT_LOCAL as DETECT_SYSTEM_PROMPT,
  REVIEW_LOCAL as REVIEW_SYSTEM_PROMPT,
} from '../../prompts/claim-dedup-judge.js';

/**
 * The two model calls `claim_dedup` makes on a candidate pair, the same two-pass shape
 * `supersession.ts`/`supersession-review.ts` use for a contradiction: one call proposes, a
 * second argues the other side on the same evidence, and only unanimous agreement acts.
 *
 * Detection here asks a different question than supersession's does. Supersession asks whether
 * a newer claim replaces an older one; this asks whether two current claims are the same
 * assertion said twice. A restatement is not evidence either one is wrong, so nothing here
 * closes on a contradiction basis, and the write path (`claim-dedup-queries.ts`) never touches
 * either text.
 */

export type ClaimDedupPair = {
  readonly subjectLabel: string;
  readonly candidateLabel: string;
  readonly subject: string;
  readonly candidate: string;
};

export type ClaimDedupCallOptions = {
  readonly model: string;
  readonly timeoutMs: number;
  /** The tick's own abort. A shutdown must not wait out a model call with a minute left. */
  readonly signal?: AbortSignal;
};

/**
 * Both passes name the value, since the provider sends the parameter only when a caller does.
 * Unanimity is the gate that merges two claims, and a sampled pass makes that gate answer
 * differently on the same pair from one tick to the next.
 */
const JUDGE_TEMPERATURE = 0;

const NO_REASON_GIVEN = 'the judge gave no reason';

function buildDetectMessages(pair: ClaimDedupPair): ChatMessage[] {
  return [
    { role: 'system', content: DETECT_SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `Claim A (kind ${pair.subjectLabel}):\n${pair.subject}\n\n` +
        `Claim B (kind ${pair.candidateLabel}):\n${pair.candidate}`,
    },
  ];
}

function buildReviewMessages(pair: ClaimDedupPair): ChatMessage[] {
  return [
    { role: 'system', content: REVIEW_SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `Claim A (kind ${pair.subjectLabel}):\n${pair.subject}\n\n` +
        `Claim B (kind ${pair.candidateLabel}):\n${pair.candidate}`,
    },
  ];
}

const DETECT_JSON_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    same: { type: 'boolean' },
    rationale: { type: 'string' },
  },
  required: ['same'],
};

const REVIEW_JSON_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    reason: { type: 'string' },
    either_adds_information: { type: 'boolean' },
  },
  required: ['reason', 'either_adds_information'],
};

/** Looser than the JSON schema on purpose: an answer missing its rationale is still usable. */
const DetectSchema = z.object({
  same: z.boolean(),
  rationale: z.string().optional(),
});

const ReviewSchema = z.object({
  either_adds_information: z.boolean(),
  reason: z.string().optional(),
});

export type ClaimDedupJudgment = {
  readonly same: boolean;
  readonly rationale?: string;
};

/** `failed` covers a call that threw, timed out, or answered in a shape the schema refuses. */
export type ClaimDedupJudgeOutcome =
  | { readonly status: 'judged'; readonly judgment: ClaimDedupJudgment }
  | { readonly status: 'failed'; readonly detail: string };

export type ClaimDedupReview =
  { readonly outcome: 'unanimous' } | { readonly outcome: 'vetoed'; readonly reason: string };

export type ClaimDedupReviewOutcome =
  | { readonly status: 'reviewed'; readonly review: ClaimDedupReview }
  | { readonly status: 'failed'; readonly detail: string };

/**
 * Pass one, prompt and schema included. Exported for the same reason `judgeContradiction` is:
 * a battery that rebuilt the prompt would report a number for a judge the service does not run.
 */
export async function judgeClaimDedup(
  provider: Pick<Provider, 'generate'>,
  pair: ClaimDedupPair,
  options: ClaimDedupCallOptions,
): Promise<ClaimDedupJudgeOutcome> {
  const deadline = deadlineFor(options.timeoutMs, options.signal);
  if (deadline.signal.aborted) {
    deadline.clear();
    return { status: 'failed', detail: 'the tick stopped before the call started' };
  }
  let raw: unknown;
  try {
    raw = await provider.generate({
      model: options.model,
      messages: buildDetectMessages(pair),
      schema: DETECT_JSON_SCHEMA,
      temperature: JUDGE_TEMPERATURE,
      // A two-statement comparison is not helped by reasoning, and the tick pays for it twice
      // over: this call and the second pass both fire on every candidate pair.
      think: false,
      signal: deadline.signal,
    });
  } catch (error) {
    return { status: 'failed', detail: errorMessage(error) };
  } finally {
    deadline.clear();
  }

  const parsed = DetectSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: 'failed', detail: 'the judge answered in a shape the schema refuses' };
  }
  const rationale = parsed.data.rationale?.trim();
  return {
    status: 'judged',
    judgment: {
      same: parsed.data.same,
      ...(rationale === undefined || rationale.length === 0 ? {} : { rationale }),
    },
  };
}

/**
 * Pass two, arguing the other side of an affirmative pass-one answer. It sees the same two
 * texts and nothing else: the first pass's verdict and rationale are withheld, since a reviewer
 * shown the answer it is reviewing agrees with it.
 */
export async function reviewClaimDedup(
  provider: Pick<Provider, 'generate'>,
  pair: ClaimDedupPair,
  options: ClaimDedupCallOptions,
): Promise<ClaimDedupReviewOutcome> {
  const deadline = deadlineFor(options.timeoutMs, options.signal);
  if (deadline.signal.aborted) {
    deadline.clear();
    return { status: 'failed', detail: 'the tick stopped before the call started' };
  }
  let raw: unknown;
  try {
    raw = await provider.generate({
      model: options.model,
      messages: buildReviewMessages(pair),
      schema: REVIEW_JSON_SCHEMA,
      temperature: JUDGE_TEMPERATURE,
      think: false,
      signal: deadline.signal,
    });
  } catch (error) {
    return { status: 'failed', detail: errorMessage(error) };
  } finally {
    deadline.clear();
  }

  const parsed = ReviewSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: 'failed', detail: 'the reviewer answered in a shape the schema refuses' };
  }
  if (!parsed.data.either_adds_information) {
    return { status: 'reviewed', review: { outcome: 'unanimous' } };
  }
  const stated = parsed.data.reason?.trim();
  return {
    status: 'reviewed',
    review: {
      outcome: 'vetoed',
      reason: stated === undefined || stated.length === 0 ? NO_REASON_GIVEN : stated,
    },
  };
}
