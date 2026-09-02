import { z } from 'zod';

import { deadlineFor } from '../../../infrastructure/providers/deadline-signal.js';
import type { ChatMessage, JsonSchema } from '../../../infrastructure/providers/types.js';
import type { StageContext } from '../../domain/stage.js';

/**
 * A second, independent judgment on exactly the Goal and Plan candidates cognitive extraction
 * proposed: does this state something the episode's own summary does not already say? The
 * in-prompt instruction on the first call is the primary defense; this call exists because an
 * instruction alone measurably did not stop the padding it asked the model not to do. Whether a
 * candidate survives is still the model's call, never a text comparison here, just asked a
 * second time, on a narrower question, with a chance to reconsider.
 */
const RESTATEMENT_SYSTEM_PROMPT = [
  "You check candidate Goal and Plan nodes extracted from one episode against that episode's",
  'own summary line, looking for restatements to drop. A candidate is a restatement when it',
  'says the same thing the summary already says, even in different words or as a completed',
  'goal instead of a summary sentence.',
  'Example: the summary is "closed out the duplicate remittance investigation" and a',
  'candidate Goal reads "Close the duplicate remittance investigation" or "Close out the',
  'duplicate remittance investigation", that candidate is a restatement. Completing the same',
  'thing the summary already says was completed adds no information, no matter how the goal',
  'text words it.',
  'Return the keys of every candidate that is a restatement by this test; return an empty',
  'list only when none of them are.',
].join(' ');

export type RestatementCandidate = {
  readonly key: string;
  readonly nodeIndex: number;
  readonly type: 'Goal' | 'Plan';
  readonly text: string;
};

/**
 * A call that came back and a call that never did are told apart here. Only an answer decides
 * what to drop; a failure is the stage's to report, because the nodes it would drop are still
 * good and nothing else re-extracts them.
 */
export type RestatementAnswer =
  | { readonly status: 'answered'; readonly restated: readonly string[] }
  | { readonly status: 'unusable' }
  | { readonly status: 'failed'; readonly error: unknown };

export type RestatementRequest = {
  readonly summary: string;
  readonly candidates: readonly RestatementCandidate[];
  readonly model: string;
  readonly timeoutMs: number;
};

function buildRestatementSchema(candidates: readonly RestatementCandidate[]): JsonSchema {
  return {
    type: 'object',
    properties: {
      restated: {
        type: 'array',
        items: { type: 'string', enum: candidates.map((candidate) => candidate.key) },
      },
    },
    required: ['restated'],
  };
}

function buildRestatementMessages(
  summary: string,
  candidates: readonly RestatementCandidate[],
): ChatMessage[] {
  const items = candidates
    .map((candidate) => `${candidate.key} [${candidate.type}]: ${candidate.text}`)
    .join('\n');
  return [
    { role: 'system', content: RESTATEMENT_SYSTEM_PROMPT },
    { role: 'user', content: `Episode summary:\n${summary}\n\nCandidates:\n${items}` },
  ];
}

const RestatementOutputSchema = z.object({ restated: z.array(z.string()) });

async function restatementCall(
  ctx: StageContext,
  request: RestatementRequest,
): Promise<RestatementAnswer> {
  const deadline = deadlineFor(request.timeoutMs, ctx.signal);
  try {
    const raw = await ctx.provider.generate({
      model: request.model,
      messages: buildRestatementMessages(request.summary, request.candidates),
      schema: buildRestatementSchema(request.candidates),
      think: false,
      signal: deadline.signal,
    });
    const parsed = RestatementOutputSchema.safeParse(raw);
    return parsed.success
      ? { status: 'answered', restated: parsed.data.restated }
      : { status: 'unusable' };
  } catch (error) {
    ctx.logger.warn(
      { err: error, episodeId: ctx.episodeId, candidates: request.candidates.length },
      'cognitive extraction: restatement validation call failed',
    );
    return { status: 'failed', error };
  } finally {
    deadline.clear();
  }
}

/**
 * One call, then one retry of the same question on an answer that came back unusable. A
 * transport failure or a timeout on either call is reported as a failure rather than folded
 * into the unusable answer: the two mean different things to the caller.
 */
export async function validateRestatements(
  ctx: StageContext,
  request: RestatementRequest,
): Promise<RestatementAnswer> {
  const first = await restatementCall(ctx, request);
  if (first.status === 'answered' || first.status === 'failed') {
    return first;
  }
  return restatementCall(ctx, request);
}
