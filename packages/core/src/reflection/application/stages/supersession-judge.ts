import { z } from 'zod';

import { deadlineFor } from '../../../infrastructure/providers/deadline-signal.js';
import type { ChatMessage, JsonSchema, Provider } from '../../../infrastructure/providers/types.js';

/**
 * The first pass over one pair of statements: the prompt, the schema its answer has to satisfy,
 * and the one call. Exported whole so a precision battery scores the judge the service runs
 * rather than a prompt rebuilt beside it. What the answer then does to the graph belongs to
 * `supersession-apply.ts`, and the second pass to `supersession-review.ts`.
 */

/**
 * Named rather than left to the route's default, which the provider no longer sends. Pass one of
 * the gate that closes a fact, and `supersession-review.ts` names the same value for pass two.
 */
const JUDGE_TEMPERATURE = 0;

const JUDGMENT_JSON_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    contradicts: { type: 'boolean' },
    confidence: { type: 'number' },
    rationale: { type: 'string' },
  },
  required: ['contradicts', 'confidence'],
};

/** Looser than the JSON schema on purpose: a judgment missing its rationale is still usable. */
const JudgmentSchema = z.object({
  contradicts: z.boolean(),
  confidence: z.number().optional(),
  rationale: z.string().optional(),
});

/**
 * The four discriminations the measured false positives turned on. Each rule names a shape
 * the judge answered "contradicts" to at confidence 1.0 while both statements stayed true.
 */
const SYSTEM_PROMPT = [
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

function buildMessages(
  priorKind: string,
  currentKind: string,
  prior: string,
  current: string,
  sharedSubject: string | undefined,
): ChatMessage[] {
  const subjectLine =
    sharedSubject === undefined ? '' : `\n\nBoth statements name: ${sharedSubject}`;
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `Earlier statement (kind ${priorKind}):\n${prior}\n\n` +
        `New statement (kind ${currentKind}):\n${current}${subjectLine}`,
    },
  ];
}

/** Applied only when the model omits the optional field: an unstated confidence never auto-applies. */
const UNSTATED_CONFIDENCE = 0.5;

function clampConfidence(value: number | undefined): number {
  const raw = value ?? UNSTATED_CONFIDENCE;
  if (!Number.isFinite(raw)) {
    return UNSTATED_CONFIDENCE;
  }
  return Math.min(1, Math.max(0, raw));
}

export type ContradictionJudgment = {
  readonly contradicts: boolean;
  readonly confidence: number;
  readonly rationale?: string;
};

/** Two statements and, when the shared-subject leg found one, the subject they both name. */
export type ContradictionPair = {
  readonly priorLabel: string;
  readonly currentLabel: string;
  readonly prior: string;
  readonly current: string;
  readonly sharedSubject?: string;
};

export type JudgeContradictionOptions = {
  readonly model: string;
  readonly timeoutMs: number;
  /** The caller's shutdown signal, composed under the call's own deadline. */
  readonly signal?: AbortSignal;
};

/**
 * `failed` is a call that threw or timed out; `unusable` is an answer that came back in a
 * shape the schema refuses. The stage logs the two differently and a precision battery
 * scores neither, so the caller needs them apart rather than folded into one `undefined`.
 */
export type JudgeOutcome =
  | { readonly status: 'judged'; readonly judgment: ContradictionJudgment }
  | { readonly status: 'failed'; readonly error: unknown }
  | { readonly status: 'unusable' };

/**
 * One judgment, prompt and schema included. Exported because precision is measured on this
 * call rather than on the stage around it: a battery that rebuilt the prompt would report a
 * number for a judge the service does not run.
 */
export async function judgeContradiction(
  provider: Pick<Provider, 'generate'>,
  pair: ContradictionPair,
  options: JudgeContradictionOptions,
): Promise<JudgeOutcome> {
  const deadline = deadlineFor(options.timeoutMs, options.signal);
  let raw: unknown;
  try {
    raw = await provider.generate({
      model: options.model,
      messages: buildMessages(
        pair.priorLabel,
        pair.currentLabel,
        pair.prior,
        pair.current,
        pair.sharedSubject,
      ),
      schema: JUDGMENT_JSON_SCHEMA,
      temperature: JUDGE_TEMPERATURE,
      // Reasoning buys nothing on a two-statement judgment and costs the budget (mirrors
      // the extraction stages).
      think: false,
      signal: deadline.signal,
    });
  } catch (error) {
    return { status: 'failed', error };
  } finally {
    deadline.clear();
  }

  const parsed = JudgmentSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: 'unusable' };
  }

  const rationale = parsed.data.rationale?.trim();
  return {
    status: 'judged',
    judgment: {
      contradicts: parsed.data.contradicts,
      confidence: clampConfidence(parsed.data.confidence),
      ...(rationale === undefined || rationale.length === 0 ? {} : { rationale }),
    },
  };
}
