import { AnthropicRequestError, AnthropicResponseError } from './anthropic-errors.js';
import { parseJsonPayload } from './anthropic-json.js';
import { thinkingConfig } from './anthropic-thinking.js';
import { readUsage } from './anthropic-usage.js';
import { estimateApiCost } from './api-pricing.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { abortRequested } from './deadline-signal.js';
import {
  composeSystemBlocks,
  FRAME_CACHE_TTL,
  marksACacheWrite,
  type FrameOverride,
  type SystemBlock,
} from './request-blocks.js';
import { backoff, MAX_ATTEMPTS, retryWaitMs, throttled } from './request-retry.js';
import { boundedTokens, type SpendingGuard } from './spending.js';
import type {
  ApiCall,
  ChatMessage,
  GenerationBackend,
  JsonSchema,
  StructuredRequest,
} from './types.js';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
export const DEFAULT_MAX_TOKENS = 4096;

/** The model every generation role routes to when the key is set. */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5';

/**
 * How the caller's JSON Schema reaches the model.
 *
 * `system_prompt` states the schema as an instruction and parses whatever text comes back. It
 * accepts any schema a caller builds, at the cost of a validation pass the
 * caller has to run itself. This is the production mode: the stages validate their own output,
 * and the extraction quality the gate batteries measure is the quality this mode produces.
 *
 * `output_config` is the API's own structured-output mode: the answer is constrained to the
 * schema, the guarantee a grammar-constrained decoder gives. It constrains the
 * model harder and measurably thins what extraction returns, so it is not the default; it is
 * where a prompt-delivered answer that will not parse is retried. The API refuses an object
 * schema that leaves `additionalProperties` unset, which every schema the stages build does,
 * so `closeObjectSchemas` sets it before the call.
 */
export type SchemaDelivery = 'output_config' | 'system_prompt';

/** Stated once, so the service and the test-support client cannot drift onto different routes. */
export const DEFAULT_SCHEMA_DELIVERY: SchemaDelivery = 'system_prompt';

type ConversationMessage = { role: 'user' | 'assistant'; content: string };

/** Both remote APIs take system instructions outside the conversation messages. */
export function splitSystem(messages: readonly ChatMessage[]): {
  system: string | undefined;
  rest: ConversationMessage[];
} {
  const systemParts: string[] = [];
  const rest: ConversationMessage[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      systemParts.push(message.content);
      continue;
    }
    rest.push({ role: message.role, content: message.content });
  }
  return { system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined, rest };
}

/**
 * The one adaptation a caller's schema needs for the API's structured-output mode: every object
 * node states that it takes no properties beyond the ones it names. The stages leave it unset
 * because Ollama does not ask for it, and they drop unknown keys on their own anyway, so
 * closing the objects here narrows nothing the callers were relying on. A node that already
 * sets it keeps what it set.
 */
export function closeObjectSchemas(schema: JsonSchema): JsonSchema {
  return closeNode(schema) as JsonSchema;
}

function closeNode(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(closeNode);
  }
  if (typeof node !== 'object' || node === null) {
    return node;
  }
  const closed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    closed[key] = closeNode(value);
  }
  if (closed.type === 'object' && closed.additionalProperties === undefined) {
    closed.additionalProperties = false;
  }
  return closed;
}

/**
 * The Messages body a batched request carries as its `params`.
 *
 * It is the same two-block composition the synchronous route sends, through the same builder, so
 * a surface that moves onto the batch lane asks the model exactly what it asked before and
 * carries the same frame ahead of the same breakpoint. Batch caching is best effort, and the
 * frame is the one part of a batch of per-entity requests that every one of them shares, so the
 * marker belongs here for the same reason it belongs on the synchronous route.
 *
 * The thinking budget stays out: every surface that batches its work sets `think: false`.
 */
export function batchMessagesBody(
  req: StructuredRequest,
  options: { readonly promptCache?: boolean; readonly frameOverride?: FrameOverride } = {},
): Record<string, unknown> {
  const { system, rest } = splitSystem(req.messages);
  return {
    model: req.model,
    max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
    system: composeSystemBlocks({
      surface: req.surface,
      instructions: system,
      schema: req.schema,
      promptCache: options.promptCache !== false,
      ...(options.frameOverride === undefined ? {} : { frameOverride: options.frameOverride }),
    }),
    messages: rest,
  };
}

export type AnthropicRequestOptions = {
  readonly apiKey: string;
  readonly fetchImpl?: typeof fetch;
  readonly maxTokens?: number;
  readonly schemaDelivery?: SchemaDelivery;
  /**
   * Whether a prefix long enough to cache carries the marker. On by default; the marker is
   * attached only where the rendered prefix reaches the API's floor, which today is no shipped
   * surface (see `anthropic-cache.ts`).
   */
  readonly promptCache?: boolean;
  /**
   * The shared frame this route sends in place of each surface's allocation, for a harness
   * comparing the same code with and without it. Absent, the allocation decides.
   */
  readonly frameOverride?: FrameOverride;
  /** Tokens a thinking call asks for. Clamped against the call's own `max_tokens` below. */
  readonly thinkingBudgetTokens?: number;
  readonly recordApiCall?: (call: ApiCall) => void;
  /**
   * The day's spending backstop, consulted before the request is sent. Absent leaves the route
   * unbounded, which is what a caller composing a provider outside a substrate store gets.
   */
  readonly spending?: SpendingGuard;
  readonly now?: () => number;
};

/**
 * One call, one schema-delivery mode, parsed. A 429, an overload, or a 5xx is a normal event
 * on a shared key rather than a failure, so three attempts absorb it with an honor-retry-after
 * wait. Throwing on the first one hands it to the reflection worker's backoff, which stretches
 * to minutes.
 */
async function askAnthropic(
  options: AnthropicRequestOptions,
  req: StructuredRequest,
  viaPrompt: boolean,
): Promise<unknown> {
  const now = options.now ?? Date.now;
  const started = now();
  const fetchImpl = options.fetchImpl ?? fetch;
  const { system, rest } = splitSystem(req.messages);
  // One composition for both delivery modes: the frame is block one either way, and what changes
  // is only whether the schema rides in block two or in `output_config` below.
  const systemBlocks: readonly SystemBlock[] = composeSystemBlocks({
    surface: req.surface,
    instructions: system,
    ...(viaPrompt ? { schema: req.schema } : {}),
    promptCache: options.promptCache !== false,
    ...(options.frameOverride === undefined ? {} : { frameOverride: options.frameOverride }),
  });

  const maxTokens = req.maxTokens ?? options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const thinking = thinkingConfig(req.think, maxTokens, options.thinkingBudgetTokens);

  // Serialized once, ahead of the hold, because it is both what every attempt sends and what the
  // input bound is measured on. The attempts differ in nothing a byte count can see.
  const requestBody = JSON.stringify({
    model: req.model,
    // Sent only when the caller named one, and never beside thinking: the API accepts
    // `temperature` at 1 alone once thinking is on, and answers "`temperature` may only be
    // set to 1 when thinking is enabled" to anything else. A caller asking for both wants
    // the reasoning, and the temperature it names is the repeatability it would have got
    // from the default sampling anyway. The newer model families removed the parameter
    // outright, which is the other reason it is sent only on request.
    ...(req.temperature === undefined || thinking !== undefined
      ? {}
      : { temperature: req.temperature }),
    max_tokens: maxTokens,
    ...(thinking === undefined ? {} : { thinking }),
    ...(systemBlocks.length === 0 ? {} : { system: systemBlocks }),
    ...(viaPrompt
      ? {}
      : {
          output_config: {
            format: { type: 'json_schema', schema: closeObjectSchemas(req.schema) },
          },
        }),
    messages: rest,
  });

  // Before the request is sent, not after it is billed. A throttled attempt is not billed and
  // rides inside this one hold; the constrained retry `requestAnthropicJson` makes is a second
  // dispatch and takes its own, which is what makes a retry cost the day what it costs the bill.
  const surface = req.surface ?? 'unlabeled';
  const held = options.spending?.hold({
    surface,
    model: req.model,
    route: 'messages',
    ...boundedTokens(Buffer.byteLength(requestBody, 'utf8'), maxTokens),
    // A marked prefix is the one shape whose input can bill at the cache-write rate, and the
    // frame is written for the hour, which is the more expensive of the two write rates.
    cacheWrite: marksACacheWrite(systemBlocks),
    cacheWriteTtl: FRAME_CACHE_TTL,
    now: new Date(started),
  });
  if (held !== undefined && 'refused' in held) {
    throw held.refused;
  }
  const hold = held?.hold;
  // Set the moment the hold is replaced by the bill.
  let reconciled = false;
  // Set the moment the request can have reached the remote. Everything after that point is money
  // the remote may already have spent, whatever this process goes on to learn about it.
  let dispatched = false;

  try {
    // Nothing has left the machine yet, so a deadline that expired while this call waited its
    // turn is an established non-dispatch and gives the day its dollars straight back.
    req.signal?.throwIfAborted();
    let response!: Response;
    let attempts = 1;
    for (; ; attempts += 1) {
      dispatched = true;
      response = await fetchImpl(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': options.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: requestBody,
        ...(req.signal === undefined ? {} : { signal: req.signal }),
      });
      if (!throttled(response.status) || attempts >= MAX_ATTEMPTS || abortRequested(req.signal)) {
        break;
      }
      await response.text().catch(() => undefined);
      await backoff(retryWaitMs(response, attempts), req.signal);
      if (abortRequested(req.signal)) {
        break;
      }
    }

    req.signal?.throwIfAborted();

    if (!response.ok) {
      throw new AnthropicRequestError(response.status, await response.text());
    }

    const body = (await response.json()) as {
      content?: { type: string; text?: string }[];
      usage?: unknown;
    } | null;
    // A successful HTTP response is billed even if its text forces a constrained retry.
    const call: ApiCall = {
      occurredAt: new Date(started),
      model: req.model,
      surface,
      ...readUsage(body?.usage),
      durationMs: Math.max(0, now() - started),
      attempts,
    };
    options.recordApiCall?.(call);
    reconciled = true;
    // What it cost replaces what was held for it. A response whose usage would not parse settles
    // as unknown, which keeps the maximum: a charge nobody can size is not a charge of nothing.
    hold?.settle(
      call.usageError === undefined ? estimateApiCost(call, { singleRequest: true }) : undefined,
      new Date(now()),
    );
    // A thinking answer leads with its reasoning blocks and puts the JSON in a text block after
    // them, so the answer is the first text block rather than the first block. The find already
    // walked past everything else; naming thinking here is what says the walk is deliberate.
    const textBlock = body?.content?.find((block) => block.type === 'text');
    if (textBlock?.text === undefined) {
      throw new AnthropicResponseError(
        body?.content?.some((block) => block.type === 'thinking') === true
          ? 'carried reasoning and no answer, which is a budget that filled max_tokens'
          : 'missing text content',
      );
    }
    return parseJsonPayload(textBlock.text);
  } finally {
    if (!reconciled) {
      if (dispatched) {
        // The request left the machine and nothing came back that could size its charge: a
        // connection dropped after the remote accepted it, or a caller that walked away from an
        // answer it had already paid for. The bound stands until something establishes the bill.
        hold?.settle(undefined, new Date(now()));
      } else {
        hold?.release(new Date(now()));
      }
    }
  }
}

/**
 * One structured-output call over the Messages API, by raw HTTP. `req.model` names the
 * Anthropic model; the routing layer substitutes it, so callers keep reading their own
 * model from config.
 *
 * Prompt delivery gets one constrained retry when the answer will not parse. Asking for JSON
 * in the system prompt is what the stages' schemas need, and it is what the shipped extraction
 * quality was measured through, but it only asks: measured against one real episode, the model
 * closed a string value and carried on in prose, on every attempt at temperature 0. Retrying
 * that request unchanged returns the same text, so the retry switches to the mode the API
 * constrains, which is the one thing that changes the shape of the answer.
 *
 * `req.think` reaches the wire here as Haiku 4.5's extended-thinking configuration, which is a
 * token budget and not a flag. The response then carries reasoning blocks ahead of the answer
 * and bills them inside its output count, so both the parse and the usage record read that
 * shape rather than assuming one text block and one price.
 */
export async function requestAnthropicJson(
  options: AnthropicRequestOptions,
  req: StructuredRequest,
): Promise<unknown> {
  const viaPrompt = (options.schemaDelivery ?? DEFAULT_SCHEMA_DELIVERY) === 'system_prompt';
  try {
    return await askAnthropic(options, req, viaPrompt);
  } catch (err) {
    if (!viaPrompt || !(err instanceof AnthropicResponseError)) {
      throw err;
    }
    return await askAnthropic(options, req, false);
  }
}

export type AnthropicProviderOptions = {
  readonly apiKey: string;
  /** The Anthropic model every call names, whatever model the caller asked for. */
  readonly model: string;
  readonly fetchImpl?: typeof fetch;
  readonly maxTokens?: number;
  readonly schemaDelivery?: SchemaDelivery;
  readonly promptCache?: boolean;
  /** The frame override, for the harness. See `AnthropicRequestOptions`. */
  readonly frameOverride?: FrameOverride;
  readonly thinkingBudgetTokens?: number;
  readonly recordApiCall?: (call: ApiCall) => void;
  /** The day's spending backstop. Absent leaves this provider's calls unbounded. */
  readonly spending?: SpendingGuard;
  readonly breakerFailureThreshold?: number;
  readonly breakerCooldownMs?: number;
  /** The breaker's clock, passed in like every other clock rather than read from the module. */
  readonly now?: () => number;
};

/**
 * The remote generation backend. It has no `embed`: embeddings are the vector index, one
 * model owns that space for the life of a substrate, and Anthropic has no embeddings API
 * either way.
 *
 * The breaker runs its own default policy: 5 consecutive failures, then a 60s cooldown. An
 * expired key or a regional outage fails every call, and without it each queued episode pays
 * three HTTP attempts with backoff before
 * the worker's own retry gets a turn.
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
      ...(options.schemaDelivery === undefined ? {} : { schemaDelivery: options.schemaDelivery }),
      ...(options.promptCache === undefined ? {} : { promptCache: options.promptCache }),
      ...(options.frameOverride === undefined ? {} : { frameOverride: options.frameOverride }),
      ...(options.thinkingBudgetTokens === undefined
        ? {}
        : { thinkingBudgetTokens: options.thinkingBudgetTokens }),
      ...(options.recordApiCall === undefined ? {} : { recordApiCall: options.recordApiCall }),
      ...(options.spending === undefined ? {} : { spending: options.spending }),
      ...(options.now === undefined ? {} : { now: options.now }),
    };
    this.#model = options.model;
    this.#breaker = new CircuitBreaker({
      ...(options.breakerFailureThreshold === undefined
        ? {}
        : { failureThreshold: options.breakerFailureThreshold }),
      ...(options.breakerCooldownMs === undefined ? {} : { cooldownMs: options.breakerCooldownMs }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }

  get model(): string {
    return this.#model;
  }

  generate(req: StructuredRequest): Promise<unknown> {
    return this.#breaker.run(() =>
      requestAnthropicJson(this.#options, { ...req, model: this.#model }),
    );
  }
}
