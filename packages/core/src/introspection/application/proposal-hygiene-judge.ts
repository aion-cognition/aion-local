import { z } from 'zod';

import { errorMessage } from '../../infrastructure/errors.js';
import { deadlineFor } from '../../infrastructure/providers/deadline-signal.js';
import type { ChatMessage, JsonSchema, Provider } from '../../infrastructure/providers/types.js';

/**
 * The one model call `proposal_hygiene` makes: a fuzzy entity-merge pair nobody resolved
 * within the residue horizon, judged once so the dismissal reason says something sharper
 * than "it aged out". Neither verdict merges or blocks anything; the cascade's deterministic
 * tier stays the only sanctioned auto-apply. This call only decides what the ledger records
 * on the way to a resolve `aion proposals reopen` can always undo.
 */

const SYSTEM_PROMPT = [
  'You review one candidate entity-merge pair a memory substrate found and nobody resolved.',
  'You are given both names and types. Judge whether they name the same real-world thing or',
  'are genuinely two different things.',
  'Answer same only when you are confident a person would merge them; answer distinct',
  'otherwise, including when you are unsure.',
  'Answer with the verdict and one sentence of reason.',
].join(' ');

function buildMessages(pair: HygienePair): ChatMessage[] {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `Left: "${pair.leftName}" (${pair.leftType})\n` +
        `Right: "${pair.rightName}" (${pair.rightType})`,
    },
  ];
}

const JUDGE_JSON_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['same', 'distinct'] },
    reason: { type: 'string' },
  },
  required: ['verdict'],
};

/** Looser than the JSON schema: an answer missing its reason is still a usable verdict. */
const JudgeSchema = z.object({
  verdict: z.string(),
  reason: z.string().optional(),
});

export type HygienePair = {
  readonly leftName: string;
  readonly leftType: string;
  readonly rightName: string;
  readonly rightType: string;
};

export type HygieneJudgeOptions = {
  readonly model: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
};

export type HygieneJudgeVerdict =
  | { readonly status: 'distinct'; readonly reason: string }
  | { readonly status: 'same'; readonly reason: string }
  | { readonly status: 'failed'; readonly reason: string }
  | { readonly status: 'unusable'; readonly reason: string };

const NO_REASON_GIVEN = 'the judge gave no reason';

export async function judgeHygienePair(
  provider: Pick<Provider, 'generate'>,
  pair: HygienePair,
  options: HygieneJudgeOptions,
): Promise<HygieneJudgeVerdict> {
  const deadline = deadlineFor(options.timeoutMs, options.signal);
  if (deadline.signal.aborted) {
    deadline.clear();
    return { status: 'failed', reason: 'the loop stopped before the call started' };
  }
  let raw: unknown;
  try {
    raw = await provider.generate({
      model: options.model,
      messages: buildMessages(pair),
      schema: JUDGE_JSON_SCHEMA,
      think: false,
      signal: deadline.signal,
    });
  } catch (error) {
    return { status: 'failed', reason: errorMessage(error) };
  } finally {
    deadline.clear();
  }

  const parsed = JudgeSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: 'unusable', reason: 'the judge answered in a shape the schema refuses' };
  }
  const stated = parsed.data.reason?.trim();
  const reason = stated === undefined || stated.length === 0 ? NO_REASON_GIVEN : stated;
  const verdict = parsed.data.verdict.trim().toLowerCase();
  if (verdict === 'same') {
    return { status: 'same', reason };
  }
  if (verdict === 'distinct') {
    return { status: 'distinct', reason };
  }
  return { status: 'unusable', reason: `the judge answered "${verdict}", not same or distinct` };
}
