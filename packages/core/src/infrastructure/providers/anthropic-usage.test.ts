import { afterEach, expect, it, vi } from 'vitest';

import { AnthropicProvider } from './anthropic-provider.js';

afterEach(() => {
  vi.useRealTimers();
});

const REQUEST = {
  model: 'local-model',
  surface: 'cognitive',
  messages: [{ role: 'user' as const, content: 'a record' }],
  schema: { type: 'object' },
};
const USAGE = {
  input_tokens: 100,
  output_tokens: 20,
  cache_creation_input_tokens: 200,
  cache_read_input_tokens: 700,
};

it('records the resolved model, caller surface, retry count, latency, and usage', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-06T10:00:00Z'));
  const recordApiCall = vi.fn();
  const fetchImpl = vi
    .fn()
    .mockResolvedValueOnce(new Response('busy', { status: 429, headers: { 'retry-after': '1' } }))
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ content: [{ type: 'text', text: '{}' }], usage: USAGE })),
    );
  const provider = new AnthropicProvider({
    apiKey: 'test',
    model: 'claude-haiku-4-5',
    fetchImpl,
    recordApiCall,
  });
  const pending = provider.generate(REQUEST);
  await vi.advanceTimersByTimeAsync(1000);
  await expect(pending).resolves.toEqual({});
  expect(recordApiCall).toHaveBeenCalledExactlyOnceWith({
    occurredAt: new Date('2026-09-06T10:00:00Z'),
    model: 'claude-haiku-4-5',
    surface: 'cognitive',
    inputTokens: 100,
    outputTokens: 20,
    cacheCreationTokens: 200,
    cacheReadTokens: 700,
    durationMs: 1000,
    attempts: 2,
  });
});

it('records unlabeled calls and defaults absent cache counters to zero', async () => {
  const recordApiCall = vi.fn();
  const provider = new AnthropicProvider({
    apiKey: 'test',
    model: 'claude-haiku-4-5',
    recordApiCall,
    fetchImpl: vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: '{}' }],
          usage: { input_tokens: 10, output_tokens: 2 },
        }),
      ),
    ),
  });
  await provider.generate({
    model: REQUEST.model,
    messages: REQUEST.messages,
    schema: REQUEST.schema,
  });
  expect(recordApiCall).toHaveBeenCalledWith(
    expect.objectContaining({
      surface: 'unlabeled',
      inputTokens: 10,
      outputTokens: 2,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    }),
  );
});

it('records nothing for an HTTP failure', async () => {
  const recordApiCall = vi.fn();
  const provider = new AnthropicProvider({
    apiKey: 'test',
    model: 'claude-haiku-4-5',
    recordApiCall,
    fetchImpl: vi.fn().mockResolvedValue(new Response('bad key', { status: 401 })),
  });
  await expect(provider.generate(REQUEST)).rejects.toThrow('401');
  expect(recordApiCall).not.toHaveBeenCalled();
});

it('counts both billed responses when malformed JSON needs a constrained retry', async () => {
  const recordApiCall = vi.fn();
  const fetchImpl = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: 'not JSON' }],
          usage: USAGE,
        }),
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: '{}' }],
          usage: USAGE,
        }),
      ),
    );
  const provider = new AnthropicProvider({
    apiKey: 'test',
    model: 'claude-haiku-4-5',
    fetchImpl,
    recordApiCall,
  });
  await expect(provider.generate(REQUEST)).resolves.toEqual({});
  expect(recordApiCall).toHaveBeenCalledTimes(2);
  expect(recordApiCall.mock.calls.map(([call]) => call.attempts)).toEqual([1, 1]);
});

it('keeps a billed response even when the final constrained answer cannot parse', async () => {
  const recordApiCall = vi.fn();
  const provider = new AnthropicProvider({
    apiKey: 'test',
    model: 'claude-haiku-4-5',
    recordApiCall,
    schemaDelivery: 'output_config',
    fetchImpl: vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: 'not JSON' }],
          usage: USAGE,
        }),
      ),
    ),
  });
  await expect(provider.generate(REQUEST)).rejects.toThrow('no complete JSON');
  expect(recordApiCall).toHaveBeenCalledOnce();
});

it.each([
  undefined,
  null,
  {},
  { input_tokens: 'changed', output_tokens: 2 },
  { input_tokens: 1, output_tokens: -1 },
  { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 'changed' },
])('records an unknown-usage row when the billed usage cannot parse (%j)', async (usage) => {
  const recordApiCall = vi.fn();
  const provider = new AnthropicProvider({
    apiKey: 'test',
    model: 'claude-haiku-4-5',
    recordApiCall,
    fetchImpl: vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: '{}' }],
          usage,
        }),
      ),
    ),
  });
  await expect(provider.generate(REQUEST)).resolves.toEqual({});
  expect(recordApiCall).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      surface: 'cognitive',
      usageError: 'invalid_usage',
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      attempts: 1,
    }),
  );
});
