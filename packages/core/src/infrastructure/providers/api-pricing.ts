import type { ApiCall, ApiPricingTier } from './types.js';

type TokenPrices = {
  readonly input: number;
  readonly output: number;
  readonly cacheCreation: number;
  readonly cacheRead: number;
};

/**
 * What a batched request costs against the ordinary rate for the same tokens. Verified 2026-09-06
 * on the same pricing page as the table below: the Message Batches API bills at half.
 *
 * It is a multiplier on the price rather than on the counts. The tokens are what the model read
 * and wrote, and every reading that is not about money wants those unchanged.
 */
export const BATCH_PRICE_MULTIPLIER = 0.5;

function multiplierFor(tier: ApiPricingTier | undefined): number {
  if (tier === 'batch') {
    return BATCH_PRICE_MULTIPLIER;
  }
  return 1;
}

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
  > &
    Partial<Pick<ApiCall, 'pricingTier'>>,
): number | undefined {
  const price = API_PRICES.get(call.model);
  if (price === undefined) {
    return undefined;
  }
  return (
    (multiplierFor(call.pricingTier) *
      (call.inputTokens * price.input +
        call.outputTokens * price.output +
        call.cacheCreationTokens * price.cacheCreation +
        call.cacheReadTokens * price.cacheRead)) /
    1_000_000
  );
}
