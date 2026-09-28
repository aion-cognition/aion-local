import { z } from 'zod';

import { AnthropicRequestError } from './anthropic-errors.js';
import { parseJsonPayload } from './anthropic-json.js';
import { readUsage, type UsageCounters } from './anthropic-usage.js';
import {
  BatchNotCreatedError,
  type BatchClientOptions,
  type BatchPoll,
  type BatchRequest,
  type BatchRequestBound,
  type BatchResult,
  type BatchTransport,
} from './batch-transport.js';
import { cacheWriteClassOf } from './request-blocks.js';
import type { GenerationProvider } from './types.js';

/**
 * The Message Batches API, by raw HTTP, in the shape the adapter needs: submit a set of requests
 * under ids of its own choosing, ask whether the job has ended, and read the answers back.
 *
 * Batched requests are half price and take up to 24 hours. Results come back unordered and keyed
 * by the `custom_id` the request carried, which is why the adapter never matches by position.
 */

const BATCHES_URL = 'https://api.anthropic.com/v1/messages/batches';
const ANTHROPIC_VERSION = '2023-06-01';

/** The API's own ceiling on one batch. The adapter submits well under it. */
export const MAX_BATCH_REQUESTS = 100_000;

/**
 * What the API accepts as a `custom_id`: one to sixty-four letters, digits, underscores and
 * hyphens. A colon, a slash or a sixty-fifth character is refused, and the refusal is of the
 * whole submission rather than of the one request that carried it.
 *
 * A producer whose durable identity is none of those things writes down a digest of it and keeps
 * the mapping in its own work row. The bound belongs here because this is where the contract is.
 */
const CUSTOM_ID = /^[a-zA-Z0-9_-]{1,64}$/;

/** Whether the remote will accept this id. */
export function legalCustomId(customId: string): boolean {
  return CUSTOM_ID.test(customId);
}

/**
 * `in_progress` means the remote is still working. `ended` means every request reached one of
 * the four outcomes below, including a batch the API expired at its 24-hour ceiling.
 */
export type BatchProcessingStatus = 'in_progress' | 'canceling' | 'ended';

export type BatchStatus = {
  readonly id: string;
  readonly processingStatus: BatchProcessingStatus;
  readonly resultsUrl: string | undefined;
  readonly counts: {
    readonly processing: number;
    readonly succeeded: number;
    readonly errored: number;
    readonly canceled: number;
    readonly expired: number;
  };
};

const COUNTS_SCHEMA = z.object({
  processing: z.number().int().nonnegative().default(0),
  succeeded: z.number().int().nonnegative().default(0),
  errored: z.number().int().nonnegative().default(0),
  canceled: z.number().int().nonnegative().default(0),
  expired: z.number().int().nonnegative().default(0),
});

const BATCH_SCHEMA = z.object({
  id: z.string().min(1),
  processing_status: z.enum(['in_progress', 'canceling', 'ended']),
  results_url: z.string().min(1).nullish(),
  request_counts: COUNTS_SCHEMA.default({
    processing: 0,
    succeeded: 0,
    errored: 0,
    canceled: 0,
    expired: 0,
  }),
});

const RESULT_SCHEMA = z.object({
  custom_id: z.string().min(1),
  result: z.object({
    type: z.enum(['succeeded', 'errored', 'canceled', 'expired']),
    message: z.unknown().optional(),
    error: z.unknown().optional(),
  }),
});

function headers(apiKey: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
  };
}

function toStatus(parsed: z.infer<typeof BATCH_SCHEMA>): BatchStatus {
  return {
    id: parsed.id,
    processingStatus: parsed.processing_status,
    resultsUrl: parsed.results_url ?? undefined,
    counts: parsed.request_counts,
  };
}

/**
 * Submits one batch and answers with the remote identity it was given. That identity is the only
 * way back to the answers, so the caller writes it down before it does anything else.
 */
export async function createMessageBatch(
  options: BatchClientOptions,
  requests: readonly BatchRequest[],
): Promise<BatchStatus> {
  const rejected = requests.find((request) => !legalCustomId(request.customId));
  if (rejected !== undefined) {
    throw new Error(`custom_id "${rejected.customId}" is outside what the batch API accepts`);
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(BATCHES_URL, {
    method: 'POST',
    headers: headers(options.apiKey),
    body: JSON.stringify({
      requests: requests.map((request) => ({
        custom_id: request.customId,
        params: request.params,
      })),
    }),
  });
  if (!response.ok) {
    throw new AnthropicRequestError(response.status, await response.text());
  }
  return toStatus(BATCH_SCHEMA.parse(await response.json()));
}

export async function retrieveMessageBatch(
  options: BatchClientOptions,
  batchId: string,
): Promise<BatchStatus> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${BATCHES_URL}/${encodeURIComponent(batchId)}`, {
    headers: headers(options.apiKey),
  });
  if (!response.ok) {
    throw new AnthropicRequestError(response.status, await response.text());
  }
  return toStatus(BATCH_SCHEMA.parse(await response.json()));
}

/**
 * Every answer in one ended batch, read from the results file.
 *
 * The file is newline-delimited JSON in whatever order the remote finished the work, which is
 * why the caller dispatches by `custom_id`. A line that will not parse is dropped rather than
 * failing the read: one malformed answer must not strand the rest of the batch.
 */
export async function readBatchResults(
  options: BatchClientOptions,
  resultsUrl: string,
): Promise<readonly BatchResult[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(resultsUrl, { headers: headers(options.apiKey) });
  if (!response.ok) {
    throw new AnthropicRequestError(response.status, await response.text());
  }
  const body = await response.text();
  const results: BatchResult[] = [];
  for (const line of body.split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }
    let parsed;
    try {
      parsed = RESULT_SCHEMA.safeParse(JSON.parse(line));
    } catch {
      continue;
    }
    if (!parsed.success) {
      continue;
    }
    const { custom_id: customId, result } = parsed.data;
    if (result.type === 'succeeded') {
      results.push({ customId, type: 'succeeded', message: result.message });
      continue;
    }
    results.push({
      customId,
      type: result.type,
      detail: JSON.stringify(result.error ?? result.type).slice(0, 200),
    });
  }
  return results;
}

/**
 * The Message Batches API as the batch lane's transport. A batch whose results file is not yet
 * named reads as still working, because the answers are not readable until it is.
 */
export class AnthropicBatchTransport implements BatchTransport {
  readonly provider: GenerationProvider = 'anthropic';
  readonly maxRequests = MAX_BATCH_REQUESTS;
  readonly #options: BatchClientOptions;

  constructor(options: BatchClientOptions) {
    this.#options = options;
  }

  /**
   * `batchMessagesBody` marks the shared frame where it reaches the cache floor, so whether a
   * request can bill input at a write rate is a property of the stored body and not of the lane.
   */
  bound(request: unknown): BatchRequestBound {
    const body = (request ?? {}) as { model?: unknown; max_tokens?: unknown };
    return {
      model: typeof body.model === 'string' ? body.model : undefined,
      outputTokens: typeof body.max_tokens === 'number' ? body.max_tokens : 0,
      ...cacheWriteClassOf(request),
    };
  }

  /** An error response is a refusal: the API answered and created nothing. */
  async create(requests: readonly BatchRequest[]): Promise<string> {
    try {
      return (await createMessageBatch(this.#options, requests)).id;
    } catch (err) {
      if (err instanceof AnthropicRequestError) {
        throw new BatchNotCreatedError('the batch API refused to create the job', { cause: err });
      }
      throw err;
    }
  }

  async poll(batchId: string): Promise<BatchPoll> {
    const status = await retrieveMessageBatch(this.#options, batchId);
    if (status.processingStatus !== 'ended' || status.resultsUrl === undefined) {
      return { state: 'working' };
    }
    return { state: 'ended', sources: [status.resultsUrl] };
  }

  async results(sources: readonly string[]): Promise<readonly BatchResult[]> {
    const read: BatchResult[] = [];
    for (const resultsUrl of sources) {
      read.push(...(await readBatchResults(this.#options, resultsUrl)));
    }
    return read;
  }

  /**
   * The JSON value inside a batched Messages response, read the way the synchronous route reads
   * one: the first text block, past any reasoning blocks ahead of it.
   */
  answerOf(message: unknown): unknown {
    const content = (message as { content?: { type: string; text?: string }[] } | null)?.content;
    const text = content?.find((block) => block.type === 'text')?.text;
    if (text === undefined) {
      throw new Error('batched response carried no text content');
    }
    return parseJsonPayload(text);
  }

  chargeOf(message: unknown): { readonly model: string; readonly usage: UsageCounters } {
    const response = message as { model?: unknown; usage?: unknown } | null;
    return {
      model: typeof response?.model === 'string' ? response.model : 'unknown',
      usage: readUsage(response?.usage),
    };
  }
}

/** Asks the remote to stop a batch. Requests already finished still return their answers. */
export async function cancelMessageBatch(
  options: BatchClientOptions,
  batchId: string,
): Promise<BatchStatus> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${BATCHES_URL}/${encodeURIComponent(batchId)}/cancel`, {
    method: 'POST',
    headers: headers(options.apiKey),
  });
  if (!response.ok) {
    throw new AnthropicRequestError(response.status, await response.text());
  }
  return toStatus(BATCH_SCHEMA.parse(await response.json()));
}
