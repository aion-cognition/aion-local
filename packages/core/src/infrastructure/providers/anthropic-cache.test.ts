import { describe, expect, it, vi } from 'vitest';

import { AnthropicProvider, type SchemaDelivery } from './anthropic-provider.js';
import { ProviderRouter } from './role-provider.js';
import { loadConfig } from '../config/load-config.js';

function requestBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== 'string') {
    throw new Error('expected a JSON string request body');
  }
  return JSON.parse(init.body) as Record<string, unknown>;
}

const REQUEST = {
  model: 'claude-haiku-4-5',
  messages: [
    { role: 'system' as const, content: 'extract records' },
    { role: 'system' as const, content: 'use the supplied schema' },
    { role: 'user' as const, content: 'a changing record' },
  ],
  schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
};

describe.each<SchemaDelivery>(['system_prompt', 'output_config'])('%s prompt caching', (mode) => {
  it.each([true, false])('preserves instructions with caching set to %s', async (promptCache) => {
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
    const text = 'extract records\n\nuse the supplied schema';
    const expectedText = mode === 'system_prompt' ? expect.stringContaining(text) : text;
    expect(bodies[0]?.system).toEqual(
      promptCache
        ? [{ type: 'text', text: expectedText, cache_control: { type: 'ephemeral' } }]
        : expectedText,
    );
    expect(bodies[1]?.system).toEqual(bodies[0]?.system);
    expect(bodies[0]?.messages).toEqual([{ role: 'user', content: 'a changing record' }]);
    expect(JSON.stringify(bodies[0]?.system)).not.toContain('a changing record');
    if (mode === 'system_prompt') {
      expect(JSON.stringify(bodies[0]?.system)).toContain('properties');
    }
  });
});

it.each([undefined, 'false'])(
  'threads the cache default and off switch through routing (%s)',
  async (value) => {
    const config = loadConfig({
      AION_ANTHROPIC_API_KEY: 'test',
      ...(value === undefined ? {} : { AION_ANTHROPIC_PROMPT_CACHE: value }),
    });
    let system: unknown;
    const router = new ProviderRouter({
      config,
      fetchImpl: async (_url, init) => {
        ({ system } = requestBody(init));
        return new Response(JSON.stringify({ content: [{ type: 'text', text: '{}' }] }));
      },
    });
    await router.forRole('reflect').generate(REQUEST);
    expect(Array.isArray(system)).toBe(value === undefined);
  },
);

it('omits the system field when constrained generation has no system instructions', async () => {
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
  expect(body).not.toHaveProperty('system');
});
