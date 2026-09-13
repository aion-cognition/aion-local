import { describe, expect, it } from 'vitest';

import { MIN_CACHEABLE_PREFIX_CHARS } from './anthropic-cache.js';
import { AnthropicProvider, DEFAULT_ANTHROPIC_MODEL } from './anthropic-provider.js';
import type { ApiCall } from './types.js';

/**
 * What the cache decision rests on, measured against the live API rather than inferred from the
 * docs: a marked prefix over the floor is written once and read back on the next identical call,
 * and a prefix under it caches nothing whatever the marker says.
 *
 * The long prefix here is a test probe. Nothing in `prompts/` is padded to reach the floor, and
 * the measurement that says none of them do is `prompts/prompt-prefix-size.test.ts`.
 */

const API_KEY = (process.env.AION_ANTHROPIC_API_KEY ?? '').trim();
const MODEL = process.env.AION_ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_MODEL;

/**
 * Over the floor, and stable across both calls of a run. The sentences are varied so the text
 * tokenizes like prose rather than like a run of one repeated token.
 */
function longPrefix(): string {
  const sentences = [
    'The substrate stores one experience per accepted payload.',
    'Every graph write is idempotent and bitemporal.',
    'A judgment that closes a claim records the evidence it read.',
    'Recall serves a pack assembled from several retrieval methods.',
    'The reflection queue has an interactive lane and a bulk lane.',
  ];
  const parts: string[] = [];
  let index = 0;
  while (parts.join(' ').length < MIN_CACHEABLE_PREFIX_CHARS + 2_000) {
    parts.push(`${String(index)}. ${sentences[index % sentences.length] ?? ''}`);
    index += 1;
  }
  return parts.join(' ');
}

const SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
};

async function callTwice(system: string): Promise<readonly ApiCall[]> {
  const calls: ApiCall[] = [];
  const provider = new AnthropicProvider({
    apiKey: API_KEY,
    model: MODEL,
    recordApiCall: (call) => calls.push(call),
  });
  for (const question of ['Answer with the word one.', 'Answer with the word two.']) {
    await provider.generate({
      surface: 'cache-probe',
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: question },
      ],
      schema: SCHEMA,
      maxTokens: 64,
      think: false,
    });
  }
  return calls;
}

describe.skipIf(API_KEY === '')('prompt caching against the live API', () => {
  it('writes the cache on the first call and reads it on the second', async () => {
    const calls = await callTwice(longPrefix());

    console.log(
      `cache probe: creation ${String(calls[0]?.cacheCreationTokens ?? 0)}/` +
        `${String(calls[1]?.cacheCreationTokens ?? 0)}, read ` +
        `${String(calls[0]?.cacheReadTokens ?? 0)}/${String(calls[1]?.cacheReadTokens ?? 0)}`,
    );

    expect(calls).toHaveLength(2);
    // The second call reads the prefix whatever the first did with it. The first writes the
    // entry on a cold cache and reads it when a run minutes earlier left one warm, and asserting
    // a write would make this file pass or fail on how recently it last ran.
    expect(calls[1]?.cacheReadTokens).toBeGreaterThan(0);
    const accounted = calls.map((call) => call.cacheCreationTokens + call.cacheReadTokens);
    expect(accounted[1]).toBe(accounted[0]);
    // The cached tokens replace the ordinary input charge rather than adding to it, so the
    // uncached input is the question alone. Measured 2026-09-13: a 4,315-token prefix written
    // once and read back, against 12 uncached input tokens a call.
    expect(calls[1]?.inputTokens).toBeLessThan(100);
  }, 120_000);

  it('caches nothing for a prefix under the floor, which is every shipped surface', async () => {
    const calls = await callTwice('You answer with one word and nothing else.');

    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.cacheCreationTokens)).toEqual([0, 0]);
    expect(calls.map((call) => call.cacheReadTokens)).toEqual([0, 0]);
  }, 120_000);
});
