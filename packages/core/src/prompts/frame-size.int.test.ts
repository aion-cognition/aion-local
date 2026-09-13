import { describe, expect, it } from 'vitest';

import { CONCISE_PROMPT, FRAME_VERSION, FULL_PROMPT, frameText } from './frame.js';
import { DEFAULTS } from '../infrastructure/config/defaults.js';
import {
  MIN_CACHEABLE_PREFIX_CHARS,
  MIN_CACHEABLE_PREFIX_TOKENS,
} from '../infrastructure/providers/anthropic-cache.js';
import { countSystemTokens } from '../infrastructure/providers/token-count.js';

/**
 * What the two renderings actually cost, counted by the model rather than estimated.
 *
 * The decision this settles is whether the frame reaches the caching floor, and that is a
 * question about the tokenizer: an estimate of four characters per token is a rule of thumb for
 * English, and the floor decision turns on a margin smaller than the rule's error. The endpoint
 * used here generates nothing and is not billed.
 *
 * It prints the numbers, which `--reporter=verbose` is what shows. The assertion is the verdict
 * the provider acts on: neither rendering reaches the floor, so no shipped call carries the
 * marker, and the composition is what makes it attach on its own the day one does.
 */

const API_KEY = process.env.AION_ANTHROPIC_API_KEY ?? '';

describe.skipIf(API_KEY === '')('the shared frame, measured', () => {
  it('counts both renderings against the model cache floor', async () => {
    const options = { apiKey: API_KEY, model: DEFAULTS.anthropic.model };
    const concise = await countSystemTokens(options, CONCISE_PROMPT);
    const full = await countSystemTokens(options, FULL_PROMPT);

    console.log(
      `${FRAME_VERSION}: concise ${String(concise)} tokens (${String(CONCISE_PROMPT.length)} chars),` +
        ` full ${String(full)} tokens (${String(FULL_PROMPT.length)} chars),` +
        ` floor ${String(MIN_CACHEABLE_PREFIX_TOKENS)} tokens` +
        ` (${String(MIN_CACHEABLE_PREFIX_CHARS)} chars by the estimate)`,
    );

    // Bimodal by design: both renderings are the short mode, so both cost a rounding error per
    // call and neither is padded toward a floor it has no reason to reach.
    expect(concise).toBeLessThan(MIN_CACHEABLE_PREFIX_TOKENS);
    expect(full).toBeLessThan(MIN_CACHEABLE_PREFIX_TOKENS);
    expect(full).toBeGreaterThan(concise);

    // The estimate the provider decides with is conservative in the safe direction: it must
    // never call a prefix cacheable that the tokenizer does not.
    const estimated = Math.floor(frameText('full').length / 4);
    expect(estimated).toBeLessThan(MIN_CACHEABLE_PREFIX_TOKENS);
  }, 60_000);
});
