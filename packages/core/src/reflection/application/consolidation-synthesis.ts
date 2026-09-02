import { errorMessage } from '../../infrastructure/errors.js';
import { deadlineFor } from '../../infrastructure/providers/deadline-signal.js';
import type { ChatMessage, JsonSchema, Provider } from '../../infrastructure/providers/types.js';
import {
  assembleConsolidation,
  buildConsolidationReviewMessages,
  CONSOLIDATION_REVIEW_JSON_SCHEMA,
  readConsolidationReview,
  type GroundedConsolidation,
} from '../domain/consolidation.js';
import {
  narrativeMaxTokens,
  NARRATIVE_JSON_SCHEMA,
  NarrativeOutputSchema,
  type NarrativeSource,
} from '../domain/narrative.js';

/**
 * The two calls every consolidation makes, whichever axis asked for it: one pass writes cited
 * sentences over the members, a second pass reads each sentence against the members it cited and
 * argues that it says more than they do. Unanimity writes; a veto writes nothing at all, because
 * a compression that invents is worse than no compression, and the members it would have
 * absorbed are still standing.
 *
 * No confidence anywhere. The reviewer answers whether a sentence outruns its citations, and
 * that answer is acted on as it stands rather than weighed against a bar.
 */

/**
 * Both passes route through `callModel`, so the value is named once here rather than left to the
 * route's default, which the provider no longer sends. Unanimity is what absorbs a member set,
 * and a sampled reviewer answers differently on sentences it already read.
 */
const SYNTHESIS_TEMPERATURE = 0;

export type SynthesisOptions = {
  readonly model: string;
  readonly timeoutMs: number;
  /** The tick's own abort. A shutdown must not wait out a model call with a minute left. */
  readonly signal?: AbortSignal;
};

export type SynthesisOutcome =
  | { readonly status: 'grounded'; readonly grounded: GroundedConsolidation }
  | { readonly status: 'vetoed'; readonly reason: string }
  | { readonly status: 'failed'; readonly detail: string };

async function callModel(
  provider: Pick<Provider, 'generate'>,
  request: {
    messages: readonly ChatMessage[];
    schema: JsonSchema;
    maxTokens?: number;
  },
  options: SynthesisOptions,
): Promise<{ status: 'answered'; raw: unknown } | { status: 'failed'; detail: string }> {
  const deadline = deadlineFor(options.timeoutMs, options.signal);
  if (deadline.signal.aborted) {
    deadline.clear();
    return { status: 'failed', detail: 'the run stopped before the call started' };
  }
  try {
    const raw = await provider.generate({
      model: options.model,
      messages: [...request.messages],
      schema: request.schema,
      ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
      temperature: SYNTHESIS_TEMPERATURE,
      // Reasoning buys a citation check nothing, and this pays for it twice on every member set.
      think: false,
      signal: deadline.signal,
    });
    return { status: 'answered', raw };
  } catch (error) {
    return { status: 'failed', detail: errorMessage(error) };
  } finally {
    deadline.clear();
  }
}

/**
 * Pass one and pass two over one member set. The reviewer sees the members and the draft and
 * nothing else: it is never told that the draft is about to be written, since a reviewer shown
 * the stakes of its answer starts weighing them.
 */
export async function synthesizeGrounded(
  provider: Pick<Provider, 'generate'>,
  source: NarrativeSource,
  messages: readonly ChatMessage[],
  options: SynthesisOptions,
): Promise<SynthesisOutcome> {
  const synthesis = await callModel(
    provider,
    {
      messages,
      schema: NARRATIVE_JSON_SCHEMA,
      maxTokens: narrativeMaxTokens(source.sentenceBudget),
    },
    options,
  );
  if (synthesis.status === 'failed') {
    return synthesis;
  }

  const parsed = NarrativeOutputSchema.safeParse(synthesis.raw);
  if (!parsed.success) {
    return { status: 'failed', detail: 'the synthesis answered in a shape the schema refuses' };
  }

  const grounded = assembleConsolidation(parsed.data, source);
  if (grounded.kept === 0) {
    return {
      status: 'failed',
      detail: `${String(grounded.dropped)} sentence(s) cited nothing the members hold`,
    };
  }

  const review = await callModel(
    provider,
    {
      messages: buildConsolidationReviewMessages(source, grounded),
      schema: CONSOLIDATION_REVIEW_JSON_SCHEMA,
    },
    options,
  );
  if (review.status === 'failed') {
    return review;
  }

  const verdict = readConsolidationReview(review.raw);
  if (verdict === undefined) {
    return { status: 'failed', detail: 'the reviewer answered in a shape the schema refuses' };
  }
  if (verdict.outcome === 'vetoed') {
    return { status: 'vetoed', reason: verdict.reason };
  }
  return { status: 'grounded', grounded };
}
