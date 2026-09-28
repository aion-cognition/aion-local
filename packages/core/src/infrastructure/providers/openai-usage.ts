import { z } from 'zod';

import type { UsageCounters } from './anthropic-usage.js';

/**
 * What one OpenAI Responses answer says it cost, in the same counters the Anthropic reader fills.
 *
 * The two APIs count input differently. Anthropic reports ordinary, cache-write and cache-read input
 * as three classes that do not overlap. OpenAI's `input_tokens` is the whole prompt, with the cached
 * and cache-write shares inside it. Subtracting both is what makes the stored row mean what every
 * other row means; storing `input_tokens` as it came would bill the cached share twice.
 *
 * `reasoning_tokens` is the share of `output_tokens` the model spent reasoning, which is exactly
 * what `thinkingTokens` records on the Anthropic route: inside the output count, never beside it.
 */

const USAGE_SCHEMA = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  input_tokens_details: z
    .object({
      cached_tokens: z.number().int().nonnegative().optional(),
      cache_write_tokens: z.number().int().nonnegative().optional(),
    })
    .nullish(),
  output_tokens_details: z
    .object({ reasoning_tokens: z.number().int().nonnegative().optional() })
    .nullish(),
});

const UNKNOWN: UsageCounters = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  usageError: 'invalid_usage',
};

/**
 * The counters a response reported, or placeholders marked unknown where it reported none. A
 * breakdown whose parts exceed the total it is a breakdown of is unreadable too, rather than a
 * negative ordinary input.
 */
export function readOpenAiUsage(usage: unknown): UsageCounters {
  const parsed = USAGE_SCHEMA.safeParse(usage);
  if (!parsed.success) {
    return UNKNOWN;
  }
  const { data } = parsed;
  const cacheReadTokens = data.input_tokens_details?.cached_tokens ?? 0;
  const cacheCreationTokens = data.input_tokens_details?.cache_write_tokens ?? 0;
  const inputTokens = data.input_tokens - cacheReadTokens - cacheCreationTokens;
  if (inputTokens < 0) {
    return UNKNOWN;
  }
  const reasoning = data.output_tokens_details?.reasoning_tokens;
  return {
    inputTokens,
    outputTokens: data.output_tokens,
    cacheCreationTokens,
    cacheReadTokens,
    ...(reasoning === undefined ? {} : { thinkingTokens: reasoning }),
  };
}
