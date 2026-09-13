import { describe, expect, it } from 'vitest';

import { MIN_CACHEABLE_PREFIX_CHARS } from './anthropic-cache.js';
import { AnthropicProvider, DEFAULT_ANTHROPIC_MODEL } from './anthropic-provider.js';
import type { ApiCall } from './types.js';

/**
 * What the cache decision rests on, measured against the live API rather than inferred from the
 * docs: a marked prefix over the floor is written once and read back on the next identical call,
 * and a prefix under it caches nothing whatever the marker says.
 *
 * The marked prefix is the shared frame, which is the only block the composition marks: a task
 * block differs per surface and would write an entry per surface for a prefix read once. So the
 * probe overrides the frame rather than lengthening the task text. The long frame here is a test
 * probe; neither shipped rendering is padded to reach the floor, and the measurement that says so
 * is `prompts/frame-size.int.test.ts`.
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

async function callTwice(frame?: string): Promise<readonly ApiCall[]> {
  const calls: ApiCall[] = [];
  const provider = new AnthropicProvider({
    apiKey: API_KEY,
    model: MODEL,
    ...(frame === undefined ? {} : { frameOverride: { text: frame } }),
    recordApiCall: (call) => calls.push(call),
  });
  for (const question of ['Answer with the word one.', 'Answer with the word two.']) {
    await provider.generate({
      surface: 'cache-probe',
      model: MODEL,
      messages: [
        { role: 'system', content: 'You answer with one word and nothing else.' },
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
    // uncached input is what sits behind the breakpoint: the task block, its schema instruction
    // and the question. A few hundred tokens against a prefix over four thousand.
    expect(calls[1]?.inputTokens).toBeLessThan(400);
  }, 120_000);

  it('caches nothing under the shipped frame, which does not reach the floor', async () => {
    const calls = await callTwice();

    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.cacheCreationTokens)).toEqual([0, 0]);
    expect(calls.map((call) => call.cacheReadTokens)).toEqual([0, 0]);
  }, 120_000);
});
