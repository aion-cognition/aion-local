import { CircuitBreaker } from './circuit-breaker.js';
import type { ChatMessage, GenerationBackend, JsonSchema, StructuredRequest } from './types.js';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;

/** Three tries at a throttled or overloaded response, then the real error reaches the caller. */
const MAX_ATTEMPTS = 3;
const MAX_BACKOFF_MS = 30_000;

/** The model every generation role routes to when the key is set. */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5';

/**
 * How the caller's JSON Schema reaches the model.
 *
 * `output_config` is the API's own structured-output mode. It refuses any object schema that
 * leaves `additionalProperties` unset, which every schema the reflection stages build does, so
 * it only fits schemas written for it.
 *
 * `system_prompt` states the schema as an instruction and parses whatever text comes back. It
 * accepts any schema a caller already hands to Ollama, at the cost of a validation pass the
 * caller has to run itself. This is the production mode: the stages validate their own output
 * and their schemas are the ones `output_config` refuses.
 */
export type SchemaDelivery = 'output_config' | 'system_prompt';

/** A non-2xx answer, after the retries. `status` is what a caller branches on. */
export class AnthropicRequestError extends Error {
  readonly status: number;

  constructor(status: number, body: string) {
    super(`Anthropic generate request failed: ${String(status)} ${body}`);
    this.name = 'AnthropicRequestError';
    this.status = status;
  }
}

/** A 2xx answer that carried no JSON value: no text block, or text no parse could read. */
export class AnthropicResponseError extends Error {
  constructor(detail: string) {
    super(`Anthropic generate response ${detail}`);
    this.name = 'AnthropicResponseError';
  }
}

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

  throw new AnthropicResponseError('carried no complete JSON value');
}

export type AnthropicRequestOptions = {
  readonly apiKey: string;
  readonly fetchImpl?: typeof fetch;
  readonly maxTokens?: number;
  readonly schemaDelivery?: SchemaDelivery;
};

function throttled(status: number): boolean {
  return status === 429 || status === 529 || status >= 500;
}

/**
 * One structured-output call over the Messages API, by raw HTTP. `req.model` names the
 * Anthropic model; the routing layer substitutes it, so callers keep reading their own
 * model from config.
 *
 * A 429, an overload, or a 5xx is a normal event on a shared key rather than a failure, so
 * three attempts absorb it with an honor-retry-after wait. Throwing on the first one hands
 * it to the reflection worker's backoff, which stretches to minutes.
 *
 * `req.think` has no counterpart here: it switches a local hybrid model's reasoning block
 * off, and this route has no such block to switch. It is dropped rather than rejected, so a
 * caller written for the local route needs no branch of its own.
 */
export async function requestAnthropicJson(
  options: AnthropicRequestOptions,
  req: StructuredRequest,
): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const { system, rest } = splitSystem(req.messages);
  const viaPrompt = (options.schemaDelivery ?? 'output_config') === 'system_prompt';
  const instructions = viaPrompt ? joinInstructions(system, schemaInstruction(req.schema)) : system;

  let response!: Response;
  for (let attempt = 1; ; attempt += 1) {
    response = await fetchImpl(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': options.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: req.model,
        // Callers that omit temperature get 0, not the API default: extraction has to be as
        // repeatable as the local route or two runs of one episode disagree on sampling luck.
        temperature: req.temperature ?? 0,
        max_tokens: req.maxTokens ?? options.maxTokens ?? DEFAULT_MAX_TOKENS,
        ...(instructions === undefined ? {} : { system: instructions }),
        ...(viaPrompt
          ? {}
          : { output_config: { format: { type: 'json_schema', schema: req.schema } } }),
        messages: rest,
      }),
      ...(req.signal === undefined ? {} : { signal: req.signal }),
    });
    if (!throttled(response.status) || attempt >= MAX_ATTEMPTS) {
      break;
    }
    const retryAfter = Number(response.headers.get('retry-after'));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : attempt * 2000;
    await response.text().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, MAX_BACKOFF_MS)));
  }

  if (!response.ok) {
    throw new AnthropicRequestError(response.status, await response.text());
  }

  const body = (await response.json()) as { content?: Array<{ type: string; text?: string }> };
  const textBlock = body.content?.find((block) => block.type === 'text');
  if (textBlock?.text === undefined) {
    throw new AnthropicResponseError('missing text content');
  }
  return parseJsonPayload(textBlock.text);
}

export type AnthropicProviderOptions = {
  readonly apiKey: string;
  /** The Anthropic model every call names, whatever model the caller asked for. */
  readonly model: string;
  readonly fetchImpl?: typeof fetch;
  readonly maxTokens?: number;
  readonly schemaDelivery?: SchemaDelivery;
  readonly breakerFailureThreshold?: number;
  readonly breakerCooldownMs?: number;
};

/**
 * The remote generation backend. It has no `embed`: embeddings are the vector index, one
 * model owns that space for the life of a substrate, and Anthropic has no embeddings API
 * either way.
 *
 * The breaker is the same policy the rest of the provider layer states (5 consecutive
 * failures, 60s cooldown). It matters more here than on the local route: an expired key or a
 * regional outage fails every call, and without it each queued episode pays three HTTP
 * attempts with backoff before the worker's own retry gets a turn.
 */
export class AnthropicProvider implements GenerationBackend {
  readonly #options: AnthropicRequestOptions;
  readonly #model: string;
  readonly #breaker: CircuitBreaker;

  constructor(options: AnthropicProviderOptions) {
    this.#options = {
      apiKey: options.apiKey,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      schemaDelivery: options.schemaDelivery ?? 'system_prompt',
    };
    this.#model = options.model;
    this.#breaker = new CircuitBreaker({
      ...(options.breakerFailureThreshold === undefined
        ? {}
        : { failureThreshold: options.breakerFailureThreshold }),
      ...(options.breakerCooldownMs === undefined ? {} : { cooldownMs: options.breakerCooldownMs }),
    });
  }

  get model(): string {
    return this.#model;
  }

  generate(req: StructuredRequest): Promise<unknown> {
    return this.#breaker.run(() => requestAnthropicJson(this.#options, { ...req, model: this.#model }));
  }
}
