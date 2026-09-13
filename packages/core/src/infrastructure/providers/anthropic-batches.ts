import { z } from 'zod';

import { AnthropicRequestError } from './anthropic-errors.js';

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

export type BatchRequest = {
  /** The work key. Unique within one batch, and what the result is matched back by. */
  readonly customId: string;
  /** A Messages request body, minus the batching wrapper. */
  readonly params: Record<string, unknown>;
};

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

/** One request's outcome. `succeeded` carries a Messages response; the rest carry a reason. */
export type BatchResult =
  | { readonly customId: string; readonly type: 'succeeded'; readonly message: unknown }
  | {
      readonly customId: string;
      readonly type: 'errored' | 'canceled' | 'expired';
      readonly detail: string;
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

export type BatchClientOptions = {
  readonly apiKey: string;
  readonly fetchImpl?: typeof fetch;
};

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
