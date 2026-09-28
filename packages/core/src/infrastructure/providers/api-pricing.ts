import type { ApiCall, ApiPricingTier, GenerationProvider } from './types.js';

type TokenRates = {
  readonly input: number;
  readonly output: number;
  /** Writing an entry that lives five minutes: 1.25x ordinary input. */
  readonly cacheCreation: number;
  /** Writing an entry that lives an hour: 2x ordinary input. */
  readonly cacheCreation1h: number;
  readonly cacheRead: number;
};

type TokenPrices = TokenRates & {
  /**
   * The card a request is billed on in full once its input passes the threshold. Absent where the
   * model has one card at every length.
   */
  readonly longContext?: { readonly aboveInputTokens: number; readonly rates: TokenRates };
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
// https://platform.claude.com/docs/en/about-claude/pricing, and the hour-long write rate re-read
// there 2026-09-13. The two write classes are priced apart because the API bills them apart: an
// entry that lives five minutes costs 1.25x ordinary input to write and one that lives an hour
// costs 2x, and a single aggregate cache-creation count cannot price a request that wrote both.
const HAIKU_45_PRICES: TokenPrices = {
  input: 1,
  output: 5,
  cacheCreation: 1.25,
  cacheCreation1h: 2,
  cacheRead: 0.1,
};
// USD per million tokens, read 2026-09-27 from https://developers.openai.com/api/docs/pricing
// (Standard tier) and the model page. OpenAI caches automatically and bills a write at 1.25x
// ordinary input with no hour-long class, so both write rates are the one write price. The long
// card applies to the whole request past 272K input tokens: the pricing table lists the long-context
// rates, and the Luna family's model pages state the threshold.
const GPT_6_LUNA_PRICES: TokenPrices = {
  input: 0.1,
  output: 0.5,
  cacheCreation: 0.125,
  cacheCreation1h: 0.125,
  cacheRead: 0.01,
  longContext: {
    aboveInputTokens: 272_000,
    rates: {
      input: 0.2,
      output: 0.75,
      cacheCreation: 0.25,
      cacheCreation1h: 0.25,
      cacheRead: 0.02,
    },
  },
};
const API_PRICES: ReadonlyMap<string, TokenPrices> = new Map([
  ['claude-haiku-4-5', HAIKU_45_PRICES],
  ['claude-haiku-4-5-20251001', HAIKU_45_PRICES],
  ['gpt-6-luna', GPT_6_LUNA_PRICES],
]);

/** The card one request is billed on, given every input token it sent, cached or not. */
function ratesFor(price: TokenPrices, inputTokens: number): TokenRates {
  const long = price.longContext;
  return long !== undefined && inputTokens > long.aboveInputTokens ? long.rates : price;
}

/**
 * The rate a model the table does not carry is bounded at: the top of the same published card,
 * which is $10 per million input tokens and $50 per million output tokens. Cache writes and cache
 * reads keep the card's own ratios to ordinary input, 1.25 and 0.1.
 *
 * It is a bound and not a price. Billing never uses it, because an unlisted model's real charge
 * is unknown and `estimateApiCost` says so. A ceiling has to say something before the dispatch,
 * and the most expensive published rate is the one number that cannot be under the bill.
 */
const UNLISTED_MODEL_PRICES: TokenPrices = {
  input: 10,
  output: 50,
  cacheCreation: 12.5,
  cacheCreation1h: 20,
  cacheRead: 1,
};

/**
 * The same bound for a model named on the OpenAI route, at the top of OpenAI's own published
 * standard card, read 2026-09-27: o1-pro at $150 per million input tokens and $600 per million
 * output tokens, with writes and reads at the card's 1.25x and 0.1x. The Anthropic figure above is
 * under a quarter of that, so an unpriced OpenAI model held there could spend past the ceiling.
 * Under the shipped daily ceiling this bound admits almost nothing, which is the honest answer
 * for a model nobody has priced: add it to the table.
 */
const UNLISTED_OPENAI_MODEL_PRICES: TokenPrices = {
  input: 150,
  output: 600,
  cacheCreation: 187.5,
  cacheCreation1h: 187.5,
  cacheRead: 15,
};

/** Whether the table carries this model, so a dispatch is priced rather than only bounded. */
export function isPricedModel(model: string): boolean {
  return API_PRICES.has(model);
}

/**
 * Unpriced models return undefined, never an invented zero-dollar estimate.
 *
 * `singleRequest` says the counts are one response's, which is the only reading a long-context
 * threshold can be judged on: it applies per request, and a day's rows summed pass it without any
 * one of them having done so. A summed group is priced on the ordinary card, which is exact for
 * every request this program builds (the largest judgment allowance is 16K characters).
 */
export function estimateApiCost(
  call: Pick<
    ApiCall,
    'model' | 'inputTokens' | 'outputTokens' | 'cacheCreationTokens' | 'cacheReadTokens'
  > &
    Partial<Pick<ApiCall, 'pricingTier' | 'cacheCreation5mTokens' | 'cacheCreation1hTokens'>>,
  options: { readonly singleRequest?: boolean } = {},
): number | undefined {
  const card = API_PRICES.get(call.model);
  if (card === undefined) {
    return undefined;
  }
  const price =
    options.singleRequest === true
      ? ratesFor(card, call.inputTokens + call.cacheCreationTokens + call.cacheReadTokens)
      : card;
  return (
    (multiplierFor(call.pricingTier) *
      (call.inputTokens * price.input +
        call.outputTokens * price.output +
        cacheCreationCost(call, price) +
        call.cacheReadTokens * price.cacheRead)) /
    1_000_000
  );
}

/**
 * What the write half cost, for one response or for a day's worth of them summed.
 *
 * The response reports the split when it wrote anything, and the split is what prices it: an
 * hour-long entry costs 2x ordinary input against a five-minute entry's 1.25x, so charging the
 * aggregate at one rate is wrong by 60% on a request that wrote for the hour. A response whose
 * usage block carried no breakdown falls back to the aggregate at the five-minute rate, which is
 * what every request written before the split existed was, and what a request without a marked
 * hour-long prefix still is.
 *
 * A summed group can hold both kinds at once, and the part the two shares do not cover is
 * exactly the calls that reported nothing. It prices at the same five-minute fallback, so a
 * group mixing reported and unreported writes costs what its rows cost one at a time.
 */
function cacheCreationCost(
  call: Pick<ApiCall, 'cacheCreationTokens'> &
    Partial<Pick<ApiCall, 'cacheCreation5mTokens' | 'cacheCreation1hTokens'>>,
  price: TokenRates,
): number {
  const hour = call.cacheCreation1hTokens;
  const minutes = call.cacheCreation5mTokens;
  if (hour === undefined && minutes === undefined) {
    return call.cacheCreationTokens * price.cacheCreation;
  }
  const unreported = Math.max(0, call.cacheCreationTokens - (minutes ?? 0) - (hour ?? 0));
  return ((minutes ?? 0) + unreported) * price.cacheCreation + (hour ?? 0) * price.cacheCreation1h;
}

export type ApiCostBound = {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly pricingTier: ApiPricingTier;
  /**
   * Whether the request carries a cache marker, which is the only way its input can be billed at
   * the cache-write rate. A request without one cannot reach that class, so pricing every hold
   * there would hold dollars no request of that shape can spend.
   */
  readonly cacheWrite: boolean;
  /**
   * Which write rate the marked prefix would bill at. The hour-long class is the more expensive
   * of the two, so a bound that priced every marked request at the five-minute rate would wave
   * an hour-long write past a ceiling it cannot actually afford.
   */
  readonly cacheWriteTtl?: '5m' | '1h';
  /** Whose card an unlisted model is bounded at. Absent reads as Anthropic's, the batch lane's. */
  readonly provider?: GenerationProvider;
};

/**
 * The most one dispatch can cost, before its answer says what it did cost.
 *
 * Two things separate it from `estimateApiCost`. A model the price table does not carry is
 * bounded at the top of the published card rather than passed through as unknown: a dollar
 * ceiling that waves an unpriced dispatch past it is not a ceiling. And the input is priced at
 * the class the request can actually be billed at, so a prompt that could bill as a cache write
 * is held at the cache-write rate rather than at the cheaper ordinary one.
 *
 * `priced` says which of the two cards the number came from, so the day's report can name the
 * dispatches it is bounding rather than pricing.
 */
export function boundApiCost(bound: ApiCostBound): {
  readonly maxUsd: number;
  readonly priced: boolean;
} {
  const price = API_PRICES.get(bound.model);
  // Judged on the bound's whole input, so a summed batch that passes a long-context threshold
  // holds at the long card: a bound errs high, and no batched model carries one today.
  const unlisted =
    bound.provider === 'openai' ? UNLISTED_OPENAI_MODEL_PRICES : UNLISTED_MODEL_PRICES;
  const card = ratesFor(price ?? unlisted, bound.inputTokens);
  const writeRate = bound.cacheWriteTtl === '1h' ? card.cacheCreation1h : card.cacheCreation;
  const inputRate = bound.cacheWrite ? writeRate : card.input;
  return {
    maxUsd:
      (multiplierFor(bound.pricingTier) *
        (bound.inputTokens * inputRate + bound.outputTokens * card.output)) /
      1_000_000,
    priced: price !== undefined,
  };
}
