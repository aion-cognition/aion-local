import { z } from 'zod';

import type { ApiCall } from './types.js';

/**
 * What one Anthropic response says it cost, read the same way on both routes.
 *
 * The synchronous route reads it off the response it is holding; the batch pump reads it off each
 * answer in a results file. One reader, because the two must agree on what an unreadable usage
 * block means: a bill that is unknown, never one that is zero.
 */

const USAGE_SCHEMA = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_creation_input_tokens: z.number().int().nonnegative().default(0),
  cache_read_input_tokens: z.number().int().nonnegative().default(0),
  /**
   * The reasoning share of `output_tokens`, never an addition to it.
   *
   * The API sends the breakdown on a thinking answer, `null` on answers that did not think, and
   * nothing at all on others. All three are valid usage blocks, so all three are accepted here:
   * refusing one of them threw away the input and output totals sitting beside it and billed the
   * call as unknown.
   *
   * A breakdown that is not there leaves the share unknown rather than at zero. Zero is a fact
   * about a call that reasoned and spent nothing on it, and a row asserting that would price and
   * read the same as one the model actually reported.
   */
  output_tokens_details: z
    .object({ thinking_tokens: z.number().int().nonnegative().optional() })
    .nullish(),
});

/** The token fields of one recorded call, ready to spread onto the rest of the record. */
export type UsageCounters = Pick<
  ApiCall,
  'inputTokens' | 'outputTokens' | 'cacheCreationTokens' | 'cacheReadTokens'
> &
  Partial<Pick<ApiCall, 'thinkingTokens' | 'usageError'>>;

/**
 * The counters a response reported, or placeholders marked unknown where it reported none.
 *
 * A billed response whose usage block will not parse is still billed. The row says so with
 * `usageError` beside zeroed counters, which reads as a charge nobody can size rather than as a
 * free call.
 */
export function readUsage(usage: unknown): UsageCounters {
  const parsed = USAGE_SCHEMA.safeParse(usage);
  if (!parsed.success) {
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      usageError: 'invalid_usage',
    };
  }
  // Left off the record entirely when the response carried no breakdown. The bill is known and
  // the split inside it is not, and those are different facts.
  const thinkingTokens = parsed.data.output_tokens_details?.thinking_tokens;
  return {
    inputTokens: parsed.data.input_tokens,
    outputTokens: parsed.data.output_tokens,
    cacheCreationTokens: parsed.data.cache_creation_input_tokens,
    cacheReadTokens: parsed.data.cache_read_input_tokens,
    ...(thinkingTokens === undefined ? {} : { thinkingTokens }),
  };
}
