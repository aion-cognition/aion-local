import { AnthropicRequestError } from './anthropic-errors.js';
import type { SystemBlock } from './request-blocks.js';

/**
 * What the model says a prefix costs, asked of the model rather than estimated.
 *
 * `POST /v1/messages/count_tokens` is the API's own counting facility. It runs the same
 * tokenizer the billed call runs, generates nothing and is not billed, which is what makes it
 * the right instrument for a question about whether a prefix clears a caching floor: four
 * characters per token is a rule of thumb for English prose, and the difference between a
 * rule of thumb and the tokenizer is exactly the margin a floor decision turns on.
 *
 * The estimate in `anthropic-cache.ts` stays where it is and keeps its job. It runs before the
 * request leaves, on every call, and it is used in the conservative direction; this is the
 * measurement that settles what the estimate is calibrated against.
 */

const COUNT_TOKENS_URL = 'https://api.anthropic.com/v1/messages/count_tokens';
const ANTHROPIC_VERSION = '2023-06-01';

/** A minimal message, because the endpoint refuses a request with none and the count is the prefix's. */
const PROBE_MESSAGE = { role: 'user', content: '.' } as const;

export type CountTokensOptions = {
  readonly apiKey: string;
  readonly model: string;
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
};

/**
 * The token count of one system prefix.
 *
 * The probe message is counted with it and is the same on every call, so two prefixes measured
 * this way differ by exactly what their own text differs by.
 */
export async function countSystemTokens(
  options: CountTokensOptions,
  system: string | readonly SystemBlock[],
): Promise<number> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(COUNT_TOKENS_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': options.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({ model: options.model, system, messages: [PROBE_MESSAGE] }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (!response.ok) {
    throw new AnthropicRequestError(response.status, await response.text());
  }
  const body = (await response.json()) as { input_tokens?: unknown } | null;
  const counted = body?.input_tokens;
  if (typeof counted !== 'number' || !Number.isFinite(counted)) {
    throw new AnthropicRequestError(response.status, 'token count carried no input_tokens');
  }
  return counted;
}
