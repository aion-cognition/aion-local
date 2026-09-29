import { describe, expect, it, vi } from 'vitest';

import { ConfiguredExtractionRoute } from './configured-route.js';
import type { CognitiveExtractionResult, EntityExtractionResult } from './types.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import type { Config } from '../../../infrastructure/config/schema.js';

describe.each(['anthropic', 'openai'] as const)('extraction diagnostic on %s', (provider) => {
  it('uses the selected key and configured model for both extractors', async () => {
    const model = `${DEFAULTS[provider].model}-configured`;
    const config: Config = {
      ...DEFAULTS,
      generation: { ...DEFAULTS.generation, provider },
      [provider]: { ...DEFAULTS[provider], apiKey: 'selected-test-key', model },
    };
    const entities: EntityExtractionResult = { entities: [{ name: 'Aion', type: 'project' }] };
    const cognitive: CognitiveExtractionResult = {
      nodes: [{ type: 'Decision', text: 'Use Aion for memory.' }],
    };
    const requests: { address: string; body: unknown; headers: Headers }[] = [];
    const onGeneration = vi.fn();
    const fetchImpl: typeof fetch = async (url, init) => {
      if (typeof init?.body !== 'string') {
        throw new Error('expected a JSON request body');
      }
      const text = JSON.stringify(requests.length === 0 ? entities : cognitive);
      requests.push({
        address: url instanceof Request ? url.url : url.toString(),
        body: JSON.parse(init.body) as unknown,
        headers: new Headers(init.headers),
      });
      const usage = { input_tokens: 10, output_tokens: 5 };
      return new Response(
        JSON.stringify(
          provider === 'anthropic'
            ? { content: [{ type: 'text', text }], usage }
            : {
                status: 'completed',
                output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
                usage,
              },
        ),
      );
    };
    const route = new ConfiguredExtractionRoute({ config, fetchImpl, onGeneration });

    expect(route.available).toBe(true);
    expect(route.route).toBe(provider);
    expect(route.model).toBe(model);
    expect(await route.extractEntities('We decided to use Aion for memory.')).toMatchObject({
      ok: true,
      value: entities,
    });
    expect(await route.extractCognitive('We decided to use Aion for memory.')).toMatchObject({
      ok: true,
      value: cognitive,
    });
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.address).toBe(
        provider === 'anthropic'
          ? 'https://api.anthropic.com/v1/messages'
          : 'https://api.openai.com/v1/responses',
      );
      expect(request.body).toMatchObject({ model });
      expect(request.headers.get(provider === 'anthropic' ? 'x-api-key' : 'authorization')).toBe(
        provider === 'anthropic' ? 'selected-test-key' : 'Bearer selected-test-key',
      );
    }
    expect(onGeneration).toHaveBeenCalledTimes(2);
    expect(onGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'reflect', provider, model, ok: true }),
    );
  });

  it('does not use the other provider when the selected key is missing', async () => {
    const other = provider === 'anthropic' ? 'openai' : 'anthropic';
    const config: Config = {
      ...DEFAULTS,
      generation: { ...DEFAULTS.generation, provider },
      [other]: { ...DEFAULTS[other], apiKey: 'unselected-test-key' },
    };
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.reject(new Error('unexpected dispatch')));
    const route = new ConfiguredExtractionRoute({ config, fetchImpl });

    expect(route.available).toBe(false);
    expect(route.route).toBe(provider);
    expect(await route.extractEntities('Aion stores memory.')).toMatchObject({
      ok: false,
      failure: 'refused',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
