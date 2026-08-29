import type { ChatMessage, JsonSchema, StructuredRequest } from '../types.js';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;

/**
 * How the caller's JSON Schema reaches the model.
 *
 * `output_config` is the API's own structured-output mode. It refuses any object schema that
 * leaves `additionalProperties` unset, which every schema the reflection stages build does, so
 * it only fits schemas written for it.
 *
 * `system_prompt` states the schema as an instruction and parses whatever text comes back. It
 * accepts any schema a caller already hands to Ollama, at the cost of a validation pass the
 * caller has to run itself.
 */
export type SchemaDelivery = 'output_config' | 'system_prompt';

export type AnthropicClientOptions = {
  readonly apiKey: string;
  readonly fetchImpl?: typeof fetch;
  readonly maxTokens?: number;
  readonly schemaDelivery?: SchemaDelivery;
};

type AnthropicMessage = { role: 'user' | 'assistant'; content: string };

/** The model wraps JSON in a fence often enough that stripping one is cheaper than a retry. */
const FENCED_JSON = /^```(?:json)?\s*([\s\S]*?)\s*```$/;

/** Anthropic takes system instructions as a top-level string, not a `system`-role message. */
function splitSystem(messages: readonly ChatMessage[]): {
  system: string | undefined;
  rest: AnthropicMessage[];
} {
  const systemParts: string[] = [];
  const rest: AnthropicMessage[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      systemParts.push(message.content);
      continue;
    }
    rest.push({ role: message.role, content: message.content });
  }
  return { system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined, rest };
}

function schemaInstruction(schema: JsonSchema): string {
  return [
    'Answer with one JSON value and nothing else: no prose, no explanation, no code fence.',
    'The value must satisfy this JSON Schema:',
    JSON.stringify(schema),
  ].join('\n');
}

function joinInstructions(base: string | undefined, extra: string): string {
  if (base === undefined) {
    return extra;
  }
  return `${base}\n\n${extra}`;
}

function parseJsonPayload(text: string): unknown {
  const trimmed = text.trim();
  const fenced = FENCED_JSON.exec(trimmed);
  return JSON.parse(fenced?.[1] ?? trimmed) as unknown;
}

/**
 * Minimal structured-output caller for `claude-haiku-4-5` over the Messages API, by raw HTTP.
 * Two things drive it: the extraction quality harness, which compares this route against the
 * local one, and the test-support provider integration tests reach for. Embeddings stay local
 * under both, so there is no `embed` method here.
 */
export class AnthropicHaikuClient {
  readonly #apiKey: string;
  readonly #fetchImpl: typeof fetch;
  readonly #maxTokens: number;
  readonly #schemaDelivery: SchemaDelivery;

  constructor(options: AnthropicClientOptions) {
    this.#apiKey = options.apiKey;
    this.#fetchImpl = options.fetchImpl ?? fetch;
    this.#maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.#schemaDelivery = options.schemaDelivery ?? 'output_config';
  }

  async generate(req: StructuredRequest): Promise<unknown> {
    const { system, rest } = splitSystem(req.messages);
    const viaPrompt = this.#schemaDelivery === 'system_prompt';
    const instructions = viaPrompt ? joinInstructions(system, schemaInstruction(req.schema)) : system;

    const response = await this.#fetchImpl(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.#apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: req.model,
        // Callers that omit temperature get 0, not the API default: test inference has to
        // be as repeatable as a mocked provider or suite runs diverge on sampling luck.
        temperature: req.temperature ?? 0,
        max_tokens: req.maxTokens ?? this.#maxTokens,
        ...(instructions === undefined ? {} : { system: instructions }),
        ...(viaPrompt ? {} : { output_config: { format: { type: 'json_schema', schema: req.schema } } }),
        messages: rest,
      }),
      ...(req.signal === undefined ? {} : { signal: req.signal }),
    });
    if (!response.ok) {
      throw new Error(`Anthropic generate request failed: ${response.status} ${await response.text()}`);
    }

    const body = (await response.json()) as { content?: Array<{ type: string; text?: string }> };
    const textBlock = body.content?.find((block) => block.type === 'text');
    if (textBlock?.text === undefined) {
      throw new Error('Anthropic generate response missing text content');
    }
    return parseJsonPayload(textBlock.text);
  }
}
