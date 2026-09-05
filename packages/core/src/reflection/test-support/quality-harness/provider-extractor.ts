import { z } from 'zod';

import type {
  CognitiveExtractionResult,
  EntityExtractionResult,
  ExtractorOutcome,
} from './types.js';
import { describeError, formatZodError } from '../../../infrastructure/errors.js';
import { COGNITIVE_NODE_LABELS } from '../../../infrastructure/graph/cognitive-queries.js';
import type { ChatMessage, JsonSchema, Provider } from '../../../infrastructure/providers/types.js';
import {
  KEYED as COGNITIVE_KEYED,
  LOCAL as COGNITIVE_LOCAL,
} from '../../../prompts/cognitive-extraction.js';
import {
  KEYED as ENTITY_KEYED,
  LOCAL as ENTITY_LOCAL,
} from '../../../prompts/entity-extraction.js';
import { promptMode } from '../../../prompts/index.js';
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
  /** Which variant a forked surface renders here. Absent reads local, as the provider contract does. */
  readonly route?: Provider['route'];
  readonly timeoutMs?: number;
};

function entityMessages(deps: ProviderGenerateDeps, text: string): ChatMessage[] {
  const system = promptMode(deps) === 'keyed' ? ENTITY_KEYED : ENTITY_LOCAL;
  return [
    { role: 'system', content: system },
    { role: 'user', content: `Record:\n${text}` },
  ];
}

function cognitiveMessages(deps: ProviderGenerateDeps, text: string): ChatMessage[] {
  const system = promptMode(deps) === 'keyed' ? COGNITIVE_KEYED : COGNITIVE_LOCAL;
  return [
    { role: 'system', content: system },
    { role: 'user', content: `Episode:\n${text}` },
  ];
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
    entityMessages(deps, text),
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
    cognitiveMessages(deps, text),
    COGNITIVE_JSON_SCHEMA,
    CognitiveExtractionOutputSchema,
  );
}
