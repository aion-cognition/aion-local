import { describe, expect, it } from 'vitest';

import { estimateApiCost, boundApiCost } from './api-pricing.js';
import { readOpenAiUsage } from './openai-usage.js';

describe('reading an OpenAI usage block', () => {
  it('takes the cached and written shares out of the whole-prompt input count', () => {
    expect(
      readOpenAiUsage({
        input_tokens: 5_000,
        input_tokens_details: { cached_tokens: 3_000, cache_write_tokens: 1_200 },
        output_tokens: 250,
        output_tokens_details: { reasoning_tokens: 0 },
      }),
    ).toEqual({
      inputTokens: 800,
      outputTokens: 250,
      cacheCreationTokens: 1_200,
      cacheReadTokens: 3_000,
      thinkingTokens: 0,
    });
  });

  it('leaves the reasoning share unknown rather than zero where no breakdown came back', () => {
    const counters = readOpenAiUsage({ input_tokens: 10, output_tokens: 4 });

    expect(counters).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    });
    expect(counters).not.toHaveProperty('thinkingTokens');
  });

  it('marks a missing or self-contradicting block as a charge nobody can size, not a free call', () => {
    expect(readOpenAiUsage(undefined).usageError).toBe('invalid_usage');
    expect(
      readOpenAiUsage({
        input_tokens: 10,
        input_tokens_details: { cached_tokens: 20 },
        output_tokens: 1,
      }).usageError,
    ).toBe('invalid_usage');
  });
});

describe('pricing GPT-6 Luna', () => {
  it('prices each input class at its own rate and reasoning inside output', () => {
    const cost = estimateApiCost({
      model: 'gpt-6-luna',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheCreationTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
    });

    // $0.10 ordinary + $0.50 output + $0.125 write + $0.01 read.
    expect(cost).toBeCloseTo(0.735, 10);
  });

  it('bills one request past 272K input tokens at the long card, and a summed day at the ordinary one', () => {
    const request = {
      model: 'gpt-6-luna',
      inputTokens: 300_000,
      outputTokens: 1_000,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    };

    expect(estimateApiCost(request, { singleRequest: true })).toBeCloseTo(
      (300_000 * 0.2 + 1_000 * 0.75) / 1_000_000,
      12,
    );
    expect(estimateApiCost(request)).toBeCloseTo((300_000 * 0.1 + 1_000 * 0.5) / 1_000_000, 12);
  });

  it('bounds a dispatch at the write rate, since OpenAI can bill any prompt as a cache write', () => {
    const bound = (inputTokens: number): number =>
      boundApiCost({
        model: 'gpt-6-luna',
        inputTokens,
        outputTokens: 1_000,
        pricingTier: 'standard',
        cacheWrite: true,
        cacheWriteTtl: '5m',
      }).maxUsd;

    expect(bound(100_000)).toBeCloseTo((100_000 * 0.125 + 1_000 * 0.5) / 1_000_000, 12);
    // Past the threshold the whole request holds at the long card.
    expect(bound(300_000)).toBeCloseTo((300_000 * 0.25 + 1_000 * 0.75) / 1_000_000, 12);
  });

  it("bounds a model the table does not carry at the top of OpenAI's own card, not Anthropic's", () => {
    const bound = (provider?: 'openai') =>
      boundApiCost({
        model: 'a-model-nobody-priced',
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        pricingTier: 'standard',
        cacheWrite: false,
        ...(provider === undefined ? {} : { provider }),
      });

    expect(bound('openai')).toEqual({ maxUsd: 750, priced: false });
    expect(bound()).toEqual({ maxUsd: 60, priced: false });
  });
});
