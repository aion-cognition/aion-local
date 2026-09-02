import type { z } from 'zod';

import {
  buildCognitiveExtractionMessages,
  buildEntityExtractionMessages,
  COGNITIVE_EXTRACTION_JSON_SCHEMA,
  CognitiveExtractionOutputSchema,
  ENTITY_EXTRACTION_JSON_SCHEMA,
  EntityExtractionOutputSchema,
} from './prompts.js';
import type {
  CognitiveExtractionResult,
  EntityExtractionResult,
  ExtractorOutcome,
} from './types.js';
import { describeError, formatZodError } from '../../../infrastructure/errors.js';
import type { ChatMessage, JsonSchema, Provider } from '../../../infrastructure/providers/types.js';

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

export type ProviderGenerateDeps = {
  readonly generate: Provider['generate'];
  readonly model: string;
  readonly timeoutMs?: number;
};

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
      };
    }
    return { ok: true, value: parsed.data, latencyMs };
  } catch (error) {
    return { ok: false, error: describeError(error), latencyMs: Date.now() - startedAt };
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
    buildEntityExtractionMessages(text),
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
    buildCognitiveExtractionMessages(text),
    COGNITIVE_EXTRACTION_JSON_SCHEMA,
    CognitiveExtractionOutputSchema,
  );
}
