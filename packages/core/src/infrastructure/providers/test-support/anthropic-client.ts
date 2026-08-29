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

type JsonSpan = { readonly start: number; readonly end: number };

/**
 * Every top-level `{...}` or `[...]` run in the text, in the order they appear. The scan
 * tracks string state and escapes, so a brace inside a string value never opens or closes a
 * span, and it reports only depth-zero runs, so a nested object is part of its parent rather
 * than a candidate of its own.
 */
export function jsonSpans(text: string): readonly JsonSpan[] {
  const spans: JsonSpan[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{' || char === '[') {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }
    if (char !== '}' && char !== ']') {
      continue;
    }
    if (depth === 0) {
      continue;
    }
    depth -= 1;
    if (depth === 0 && start >= 0) {
      spans.push({ start, end: index + 1 });
      start = -1;
    }
  }

  return spans;
}

/**
 * The whole reply when the whole reply is one JSON value, and otherwise the last complete
 * value in it.
 *
 * The model sometimes answers twice: a fenced block, a line of second thoughts about its own
 * answer, then a corrected block. Requiring the reply to be one value fails outright on that
 * shape, and taking the first value hands the caller the draft the model itself rejected, which
 * is where the invalid enum values come from. The last complete value is the one it settled on.
 */
export function parseJsonPayload(text: string): unknown {
  const trimmed = text.trim();
  const fenced = FENCED_JSON.exec(trimmed);
  try {
    return JSON.parse(fenced?.[1] ?? trimmed) as unknown;
  } catch {
    // The single-value shape is the common one; anything else goes to the scan below.
  }

  for (const span of [...jsonSpans(text)].reverse()) {
    try {
      return JSON.parse(text.slice(span.start, span.end)) as unknown;
    } catch {
      continue;
    }
  }

  throw new SyntaxError('Anthropic generate response carried no complete JSON value');
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

    // A sustained suite run shares one API key across every enrichment call, so a 429 or a
    // transient overload is a normal event here, not a failure. Throwing hands it to the
    // reflection worker's own backoff, which stretches to minutes and blows the freshness
    // batteries; absorbing it with a short honor-retry-after wait keeps test inference at
    // test speed. Three attempts, then the real error propagates.
    let response!: Response;
    for (let attempt = 1; ; attempt += 1) {
      response = await this.#fetchImpl(ANTHROPIC_API_URL, {
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
      const throttled = response.status === 429 || response.status === 529 || response.status >= 500;
      if (!throttled || attempt >= 3) {
        break;
      }
      const retryAfter = Number(response.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : attempt * 2000;
      await response.text().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 30_000)));
    }
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
