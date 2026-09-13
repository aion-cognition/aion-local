import { describe, expect, it, vi } from 'vitest';

import { MIN_CACHEABLE_PREFIX_CHARS, type SystemBlock } from './anthropic-cache.js';
import { AnthropicProvider, type SchemaDelivery } from './anthropic-provider.js';
import { ProviderRouter } from './role-provider.js';
import { frameText } from '../../prompts/frame.js';
import { loadConfig } from '../config/load-config.js';

/**
 * What reaches the wire: two system blocks, the shared frame first and the surface's own text
 * second, with the cache marker on the frame alone and only where the frame is long enough for
 * the API to act on it.
 */

function requestBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== 'string') {
    throw new Error('expected a JSON string request body');
  }
  return JSON.parse(init.body) as Record<string, unknown>;
}

function systemBlocks(body: Record<string, unknown>): readonly SystemBlock[] {
  const { system } = body;
  if (!Array.isArray(system)) {
    throw new Error('expected the system field to be a block list');
  }
  return system as readonly SystemBlock[];
}

const REQUEST = {
  surface: 'cues',
  model: 'claude-haiku-4-5',
  messages: [
    { role: 'system' as const, content: 'extract records' },
    { role: 'system' as const, content: 'use the supplied schema' },
    { role: 'user' as const, content: 'a changing record' },
  ],
  schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
};

/** A frame over the floor, so the marker has something the API would act on. */
const LONG_FRAME = 'a frame sentence about what this substrate is for. '.repeat(
  Math.ceil(MIN_CACHEABLE_PREFIX_CHARS / 50) + 1,
);

describe.each<SchemaDelivery>(['system_prompt', 'output_config'])('%s composition', (mode) => {
  it.each([true, false])(
    'keeps the task text unchanged with caching set to %s',
    async (promptCache) => {
      const bodies: Record<string, unknown>[] = [];
      const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
        bodies.push(requestBody(init));
        return new Response(JSON.stringify({ content: [{ type: 'text', text: '{"ok":true}' }] }));
      });
      const provider = new AnthropicProvider({
        apiKey: 'test',
        model: REQUEST.model,
        schemaDelivery: mode,
        promptCache,
        fetchImpl,
      });
      await provider.generate(REQUEST);
      await provider.generate({
        ...REQUEST,
        messages: [...REQUEST.messages.slice(0, 2), { role: 'user', content: 'another record' }],
      });

      const first = systemBlocks(bodies[0] ?? {});
      expect(first[0]?.text).toBe(frameText('concise'));
      expect(first[1]?.text).toContain('extract records\n\nuse the supplied schema');
      expect(bodies[1]?.system).toEqual(bodies[0]?.system);
      expect(bodies[0]?.messages).toEqual([{ role: 'user', content: 'a changing record' }]);
      expect(JSON.stringify(bodies[0]?.system)).not.toContain('a changing record');
      if (mode === 'system_prompt') {
        expect(JSON.stringify(bodies[0]?.system)).toContain('properties');
      }
    },
  );
});

describe('a frame that reaches the floor', () => {
  async function blocksUnder(promptCache: boolean): Promise<readonly SystemBlock[]> {
    let body: Record<string, unknown> = {};
    const provider = new AnthropicProvider({
      apiKey: 'test',
      model: REQUEST.model,
      promptCache,
      frameOverride: { text: LONG_FRAME },
      fetchImpl: async (_url, init) => {
        body = requestBody(init);
        return new Response(JSON.stringify({ content: [{ type: 'text', text: '{}' }] }));
      },
    });
    await provider.generate(REQUEST);
    return systemBlocks(body);
  }

  it('carries the marker, written for the hour, on the frame alone', async () => {
    const blocks = await blocksUnder(true);

    expect(blocks[0]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(blocks[1]?.cache_control).toBeUndefined();
  });

  it('drops it when the switch is off', async () => {
    const blocks = await blocksUnder(false);

    expect(blocks.every((block) => block.cache_control === undefined)).toBe(true);
  });
});

it('leaves the shipped frame unmarked, because the model would not cache it', async () => {
  let body: Record<string, unknown> = {};
  const provider = new AnthropicProvider({
    apiKey: 'test',
    model: REQUEST.model,
    promptCache: true,
    fetchImpl: async (_url, init) => {
      body = requestBody(init);
      return new Response(JSON.stringify({ content: [{ type: 'text', text: '{}' }] }));
    },
  });
  await provider.generate(REQUEST);

  expect(frameText('full').length).toBeLessThan(MIN_CACHEABLE_PREFIX_CHARS);
  expect(systemBlocks(body).every((block) => block.cache_control === undefined)).toBe(true);
});

it.each([undefined, 'false'])(
  'threads the cache default and off switch through routing (%s)',
  async (value) => {
    const config = loadConfig({
      AION_ANTHROPIC_API_KEY: 'test',
      ...(value === undefined ? {} : { AION_ANTHROPIC_PROMPT_CACHE: value }),
    });
    let body: Record<string, unknown> = {};
    const router = new ProviderRouter({
      config,
      frameOverride: { text: LONG_FRAME },
      fetchImpl: async (_url, init) => {
        body = requestBody(init);
        return new Response(JSON.stringify({ content: [{ type: 'text', text: '{}' }] }));
      },
    });
    await router.forRole('reflect').generate(REQUEST);

    const marked = systemBlocks(body).some((block) => block.cache_control !== undefined);
    expect(marked).toBe(value === undefined);
  },
);

it('sends the frame alone when a constrained request has no system instructions', async () => {
  let body: Record<string, unknown> = {};
  const provider = new AnthropicProvider({
    apiKey: 'test',
    model: REQUEST.model,
    schemaDelivery: 'output_config',
    fetchImpl: async (_url, init) => {
      body = requestBody(init);
      return new Response(JSON.stringify({ content: [{ type: 'text', text: '{}' }] }));
    },
  });
  await provider.generate({ ...REQUEST, messages: [{ role: 'user', content: 'a record' }] });

  expect(systemBlocks(body)).toEqual([{ type: 'text', text: frameText('concise') }]);
});

it('sends no system field at all when the harness asks for the run without a frame', async () => {
  let body: Record<string, unknown> = {};
  const provider = new AnthropicProvider({
    apiKey: 'test',
    model: REQUEST.model,
    schemaDelivery: 'output_config',
    frameOverride: { none: true },
    fetchImpl: async (_url, init) => {
      body = requestBody(init);
      return new Response(JSON.stringify({ content: [{ type: 'text', text: '{}' }] }));
    },
  });
  await provider.generate({ ...REQUEST, messages: [{ role: 'user', content: 'a record' }] });

  expect(body).not.toHaveProperty('system');
});
