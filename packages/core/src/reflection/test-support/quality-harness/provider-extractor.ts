import { z } from 'zod';

import type {
  CognitiveExtractionResult,
  EntityExtractionResult,
  ExtractionFailure,
  ExtractorOutcome,
} from './types.js';
import { describeError, formatZodError, isAbortError } from '../../../infrastructure/errors.js';
import { COGNITIVE_NODE_LABELS } from '../../../infrastructure/graph/cognitive-queries.js';
import { isGenerationUnavailable } from '../../../infrastructure/providers/errors.js';
import type { ChatMessage, JsonSchema, Provider } from '../../../infrastructure/providers/types.js';
import { EXTRACTION_PROMPT as COGNITIVE_PROMPT } from '../../../prompts/cognitive-extraction.js';
import { EXTRACTION_PROMPT as ENTITY_PROMPT } from '../../../prompts/entity-extraction.js';
import { COGNITIVE_JSON_SCHEMA } from '../../application/stages/cognitive.js';
import { ENTITY_EXTRACTION_JSON_SCHEMA, ENTITY_TYPES } from '../../domain/entity-extraction.js';

/**
 * The harness scores the extraction the pipeline runs: the same system prompt for the route,
 * the same structured-output schema, and the same user framing each stage builds. Its own
 * output schemas stay separate, since scoring wants the model's answer as it arrived rather
 * than the folded, deduplicated form the graph stores.
 */

/**
 * qwen3:8b with thinking on measured 10-44s with occasional non-returns; reflection's
 * latency regime is relaxed but not unbounded, so every call still carries a hang guard.
 */
export const DEFAULT_GENERATE_TIMEOUT_MS = 60_000;

/**
 * Matches the stages this harness measures (`entities.ts` and `cognitive.ts` both name 0), and
 * named rather than left to the route's default, which the provider no longer sends. A sampled
 * harness scores a different extraction than the one the service runs.
 */
const EXTRACTION_TEMPERATURE = 0;

const EntityExtractionOutputSchema = z.object({
  entities: z.array(
    z.object({
      name: z.string().min(1),
      type: z.enum(ENTITY_TYPES),
    }),
  ),
});

const CognitiveExtractionOutputSchema = z.object({
  nodes: z.array(
    z.object({
      type: z.enum(COGNITIVE_NODE_LABELS),
      text: z.string().min(1),
    }),
  ),
});

export type ProviderGenerateDeps = {
  readonly generate: Provider['generate'];
  readonly model: string;
  /**
   * The route the caller states, carried for the provider contract and read by nothing here: no
   * surface has two texts any more, so every route sends the one constant its surface ships.
   */
  readonly route?: Provider['route'];
  readonly timeoutMs?: number;
};

function entityMessages(text: string): ChatMessage[] {
  return [
    { role: 'system', content: ENTITY_PROMPT },
    { role: 'user', content: `Record:\n${text}` },
  ];
}

function cognitiveMessages(text: string): ChatMessage[] {
  return [
    { role: 'system', content: COGNITIVE_PROMPT },
    { role: 'user', content: `Episode:\n${text}` },
  ];
}

/**
 * A thrown error's kind, read off the type. `GenerationUnavailableError` and its ceiling
 * subclass mean the request that threw never left, which is a different fact about the run from
 * a model that answered badly.
 *
 * That is a fact about the request, not necessarily about the whole structured call: a shape
 * failure makes `deps.generate` retry once through a second, differently-encoded request, and a
 * refusal can land on that second one after the first already dispatched and got billed. This
 * function has no way to see that earlier request, so a caller stacking several of these into one
 * logical case (`extraction-experiment.ts`) is where that distinction gets checked, against what
 * was actually recorded rather than against this classification alone.
 */
function failureKindOf(error: unknown): ExtractionFailure {
  if (isGenerationUnavailable(error)) {
    return 'refused';
  }
  return isAbortError(error) ? 'timeout' : 'call_failed';
}

/**
 * One structured-output call, timed and guarded. Reasoning buys nothing for extraction and
 * costs the budget (mirrors `recall/application/cues.ts`'s cue-model call), so `think` stays
 * off for both routes; the Anthropic client ignores the field, since Haiku 4.5 has no
 * comparable toggle.
 */
async function runStructuredExtraction<T>(
  deps: ProviderGenerateDeps,
  messages: readonly ChatMessage[],
  schema: JsonSchema,
  outputSchema: z.ZodType<T>,
): Promise<ExtractorOutcome<T>> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, deps.timeoutMs ?? DEFAULT_GENERATE_TIMEOUT_MS);
  try {
    const data = await deps.generate({
      model: deps.model,
      messages,
      schema,
      temperature: EXTRACTION_TEMPERATURE,
      think: false,
      signal: controller.signal,
    });
    const parsed = outputSchema.safeParse(data);
    const latencyMs = Date.now() - startedAt;
    if (!parsed.success) {
      return {
        ok: false,
        error: `invalid extraction output: ${formatZodError(parsed.error)}`,
        latencyMs,
        failure: 'invalid_output',
      };
    }
    return { ok: true, value: parsed.data, latencyMs };
  } catch (error) {
    // Classified here, where the error object is still in hand. A caller downstream has only the
    // sentence, and a budget refusal read out of a sentence is a guess.
    return {
      ok: false,
      error: describeError(error),
      latencyMs: Date.now() - startedAt,
      failure: failureKindOf(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

export function extractEntitiesViaProvider(
  deps: ProviderGenerateDeps,
  text: string,
): Promise<ExtractorOutcome<EntityExtractionResult>> {
  return runStructuredExtraction(
    deps,
    entityMessages(text),
    ENTITY_EXTRACTION_JSON_SCHEMA,
    EntityExtractionOutputSchema,
  );
}

export function extractCognitiveViaProvider(
  deps: ProviderGenerateDeps,
  text: string,
): Promise<ExtractorOutcome<CognitiveExtractionResult>> {
  return runStructuredExtraction(
    deps,
    cognitiveMessages(text),
    COGNITIVE_JSON_SCHEMA,
    CognitiveExtractionOutputSchema,
  );
}
