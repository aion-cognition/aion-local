import { parseJsonPayload } from './anthropic-json.js';
import { DEFAULT_MAX_TOKENS, splitSystem } from './anthropic-provider.js';
import { estimateApiCost } from './api-pricing.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { abortRequested } from './deadline-signal.js';
import { summarizeErrorBody } from './errors.js';
import { readOpenAiUsage } from './openai-usage.js';
import { composeSystemBlocks, type FrameOverride } from './request-blocks.js';
import { backoff, MAX_ATTEMPTS, retryWaitMs, throttled } from './request-retry.js';
import { boundedTokens, type SpendingGuard } from './spending.js';
import type { ApiCall, GenerationBackend, StructuredRequest } from './types.js';

/**
 * The OpenAI generation backend, over the Responses API by raw HTTP, shaped to answer exactly what
 * the Anthropic backend answers: the same composed instructions, the same spending hold and
 * settlement, the same retries and breaker, the same usage record, and the same errors at the
 * boundaries callers branch on (`GenerationUnavailableError` from the router, `AbortError` from the
 * caller's own signal).
 */

const OPENAI_API_URL = 'https://api.openai.com/v1/responses';

/** The model an OpenAI-routed role names when the operator names none. */
export const DEFAULT_OPENAI_MODEL = 'gpt-6-luna';

/**
 * The efforts a call that asked to think may be sent at. `none` is not among them: it is what a
 * call that did not ask is sent at, so configuring it here would switch reasoning off for the
 * callers that asked for it.
 */
export const OPENAI_REASONING_EFFORTS = ['low', 'medium', 'high'] as const;

export type OpenAiReasoningEffort = (typeof OPENAI_REASONING_EFFORTS)[number];

/** A non-2xx answer, after the retries. `status` is what a caller branches on. */
export class OpenAiRequestError extends Error {
  readonly status: number;

  constructor(status: number, body: string) {
    // Capped and flattened for the reason every provider error is: it reaches the logs and a
    // job's `last_error`, and a body that echoes the request would carry episode text there.
    super(`OpenAI request failed: ${String(status)} ${summarizeErrorBody(body)}`);
    this.name = 'OpenAiRequestError';
    this.status = status;
  }
}

/** A 2xx answer that carried no JSON value: no text, a cut-off answer, or text no parse could read. */
export class OpenAiResponseError extends Error {
  constructor(detail: string) {
    super(`OpenAI response ${detail}`);
    this.name = 'OpenAiResponseError';
  }
}

/**
 * The model declined to answer, or a safety filter stopped it. Not retried: the same request
 * asked again is refused again, and the constrained retry only changes the answer's shape.
 */
export class OpenAiRefusalError extends Error {
  constructor(detail: string) {
    super(`OpenAI response refused: ${summarizeErrorBody(detail)}`);
    this.name = 'OpenAiRefusalError';
  }
}

export type OpenAiRequestOptions = {
  readonly apiKey: string;
  readonly fetchImpl?: typeof fetch;
  readonly maxTokens?: number;
  /** The effort a thinking call is sent at. Absent reads as `low`. */
  readonly reasoningEffort?: OpenAiReasoningEffort;
  /** The frame override, for the harness. See `AnthropicRequestOptions`. */
  readonly frameOverride?: FrameOverride;
  readonly recordApiCall?: (call: ApiCall) => void;
  /** The day's spending backstop. Absent leaves the route unbounded. */
  readonly spending?: SpendingGuard;
  readonly now?: () => number;
};

type ContentItem = { type?: string; text?: string; refusal?: string };

type ResponseBody = {
  status?: string;
  incomplete_details?: { reason?: string } | null;
  output?: { type?: string; content?: ContentItem[] }[];
  usage?: unknown;
} | null;

/**
 * The instructions one request carries: the same frame and task blocks the Anthropic route sends,
 * joined, with the schema stated in them. The schema stays in the instructions on both attempts,
 * because the constrained retry below constrains the answer to JSON and not to this schema: the
 * strict schema mode requires every property to be required, which the stages' schemas are not.
 */
function instructionsOf(req: StructuredRequest, frameOverride: FrameOverride | undefined): string {
  const { system } = splitSystem(req.messages);
  return composeSystemBlocks({
    surface: req.surface,
    instructions: system,
    schema: req.schema,
    // OpenAI caches a long enough prefix on its own; there is no marker to place.
    promptCache: false,
    ...(frameOverride === undefined ? {} : { frameOverride }),
  })
    .map((block) => block.text)
    .join('\n\n');
}

/** The answer text, or the error that says why there is none. */
function answerText(body: ResponseBody): string {
  const content = (body?.output ?? [])
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content ?? []);
  const refusal = content.find((item) => item.type === 'refusal');
  if (refusal !== undefined) {
    throw new OpenAiRefusalError(refusal.refusal ?? '');
  }
  if (body?.status === 'incomplete') {
    const reason = body.incomplete_details?.reason ?? 'unstated';
    if (reason === 'content_filter') {
      throw new OpenAiRefusalError('stopped by the content filter');
    }
    // Reasoning is billed and counted inside `max_output_tokens`, so a thinking call can spend
    // the whole allowance before any answer text exists.
    throw new OpenAiResponseError(`was cut off (${reason}) before a complete answer`);
  }
  const text = content
    .filter((item) => item.type === 'output_text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('');
  if (text.length === 0) {
    throw new OpenAiResponseError('missing text content');
  }
  return text;
}

/**
 * One call, one delivery mode, parsed. The hold, the dispatch bookkeeping and the settlement are
 * the Anthropic route's (`askAnthropic`) rule for rule, since both routes answer to one day's
 * ceiling: held before the request leaves, released if it never did, settled at the real charge
 * once the answer says what it was, and kept at the maximum when nothing can size it.
 */
async function askOpenAi(
  options: OpenAiRequestOptions,
  req: StructuredRequest,
  constrained: boolean,
): Promise<unknown> {
  const now = options.now ?? Date.now;
  const started = now();
  const fetchImpl = options.fetchImpl ?? fetch;
  const { rest } = splitSystem(req.messages);
  const instructions = instructionsOf(req, options.frameOverride);
  const maxTokens = req.maxTokens ?? options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const effort = req.think === true ? (options.reasoningEffort ?? 'low') : 'none';

  const requestBody = JSON.stringify({
    model: req.model,
    ...(instructions.length === 0 ? {} : { instructions }),
    input: rest.map((message) => ({ role: message.role, content: message.content })),
    // Reasoning is counted inside this ceiling, the way thinking is inside `max_tokens`.
    max_output_tokens: maxTokens,
    reasoning: { effort },
    // Accepted only at effort `none`; the reasoning efforts refuse it outright.
    ...(effort !== 'none' || req.temperature === undefined ? {} : { temperature: req.temperature }),
    ...(constrained ? { text: { format: { type: 'json_object' } } } : {}),
    // Nothing here needs a stored response, and the input is memory content.
    store: false,
  });

  const surface = req.surface ?? 'unlabeled';
  const held = options.spending?.hold({
    surface,
    model: req.model,
    // The ordinary synchronous lane, as opposed to `batch`; the ledger's word for it predates
    // a second provider.
    route: 'messages',
    ...boundedTokens(Buffer.byteLength(requestBody, 'utf8'), maxTokens),
    // OpenAI caches automatically and bills a write at 1.25x ordinary input, which is the
    // five-minute write rate on the price card. Any request can incur it, so every one is held there.
    cacheWrite: true,
    cacheWriteTtl: '5m',
    now: new Date(started),
  });
  if (held !== undefined && 'refused' in held) {
    throw held.refused;
  }
  const hold = held?.hold;
  let reconciled = false;
  let dispatched = false;

  try {
    req.signal?.throwIfAborted();
    let response!: Response;
    let attempts = 1;
    for (; ; attempts += 1) {
      dispatched = true;
      response = await fetchImpl(OPENAI_API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${options.apiKey}`,
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
      throw new OpenAiRequestError(response.status, await response.text());
    }

    const body = (await response.json()) as ResponseBody;
    // A successful HTTP response is billed whatever its content turns out to be.
    const call: ApiCall = {
      occurredAt: new Date(started),
      model: req.model,
      surface,
      ...readOpenAiUsage(body?.usage),
      durationMs: Math.max(0, now() - started),
      attempts,
    };
    options.recordApiCall?.(call);
    reconciled = true;
    hold?.settle(
      call.usageError === undefined ? estimateApiCost(call, { singleRequest: true }) : undefined,
      new Date(now()),
    );
    return parseJsonPayload(answerText(body), (detail) => new OpenAiResponseError(detail));
  } finally {
    if (!reconciled) {
      if (dispatched) {
        hold?.settle(undefined, new Date(now()));
      } else {
        hold?.release(new Date(now()));
      }
    }
  }
}

/**
 * One structured-output call. The first attempt asks for JSON in the instructions, the delivery
 * the Anthropic route ships and the stages' own validation was built against. An answer that will
 * not parse gets one retry in JSON mode, which constrains the shape of the answer and is the one
 * thing that changes it; a refusal and a request error are not retried here.
 */
export async function requestOpenAiJson(
  options: OpenAiRequestOptions,
  req: StructuredRequest,
): Promise<unknown> {
  try {
    return await askOpenAi(options, req, false);
  } catch (err) {
    if (!(err instanceof OpenAiResponseError)) {
      throw err;
    }
    return await askOpenAi(options, req, true);
  }
}

export type OpenAiProviderOptions = OpenAiRequestOptions & {
  /** The OpenAI model every call names, whatever model the caller asked for. */
  readonly model: string;
  readonly breakerFailureThreshold?: number;
  readonly breakerCooldownMs?: number;
};

/**
 * The OpenAI half of generation. It has no `embed`, for the reason the Anthropic backend has
 * none: one local model owns the vector space for the life of a substrate. The breaker runs the
 * same default policy, so an expired key or an outage stops costing every queued job three
 * attempts.
 */
export class OpenAiProvider implements GenerationBackend {
  readonly #options: OpenAiRequestOptions;
  readonly #model: string;
  readonly #breaker: CircuitBreaker;

  constructor(options: OpenAiProviderOptions) {
    const { model, breakerFailureThreshold, breakerCooldownMs, ...request } = options;
    this.#options = request;
    this.#model = model;
    this.#breaker = new CircuitBreaker({
      ...(breakerFailureThreshold === undefined
        ? {}
        : { failureThreshold: breakerFailureThreshold }),
      ...(breakerCooldownMs === undefined ? {} : { cooldownMs: breakerCooldownMs }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }

  get model(): string {
    return this.#model;
  }

  generate(req: StructuredRequest): Promise<unknown> {
    return this.#breaker.run(() =>
      requestOpenAiJson(this.#options, { ...req, model: this.#model }),
    );
  }
}
