import type { ApiCall } from './types.js';

type TokenPrices = {
  readonly input: number;
  readonly output: number;
  readonly cacheCreation: number;
  readonly cacheRead: number;
};

// USD per million tokens, verified 2026-09-06 against
// https://platform.claude.com/docs/en/about-claude/pricing. Cache writes use the 5-minute TTL.
const HAIKU_45_PRICES: TokenPrices = { input: 1, output: 5, cacheCreation: 1.25, cacheRead: 0.1 };
const API_PRICES: ReadonlyMap<string, TokenPrices> = new Map([
  ['claude-haiku-4-5', HAIKU_45_PRICES],
  ['claude-haiku-4-5-20251001', HAIKU_45_PRICES],
]);

/** Unpriced models return undefined, never an invented zero-dollar estimate. */
export function estimateApiCost(
  call: Pick<
    ApiCall,
    'model' | 'inputTokens' | 'outputTokens' | 'cacheCreationTokens' | 'cacheReadTokens'
  >,
): number | undefined {
  const price = API_PRICES.get(call.model);
  if (price === undefined) {
    return undefined;
  }
  return (
    (call.inputTokens * price.input +
      call.outputTokens * price.output +
      call.cacheCreationTokens * price.cacheCreation +
      call.cacheReadTokens * price.cacheRead) /
    1_000_000
  );
}
