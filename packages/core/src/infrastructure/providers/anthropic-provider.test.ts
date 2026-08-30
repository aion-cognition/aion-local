import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AnthropicProvider,
  AnthropicRequestError,
  AnthropicResponseError,
} from './anthropic-provider.js';
import { CircuitOpenError } from './circuit-breaker.js';
import type { StructuredRequest } from './types.js';

const SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } } };

const REQUEST: StructuredRequest = {
  // An Ollama tag, because the caller reads its model from config the same way under both
  // routes. The provider substitutes the model it was built with.
  model: 'qwen3:8b',
  messages: [
    { role: 'system', content: 'you extract entities' },
    { role: 'user', content: 'the episode text' },
  ],
  schema: SCHEMA,
  think: false,
};

type Body = Record<string, unknown>;

function textResponse(text: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ content: [{ type: 'text', text }] }), { status, headers });
}

function provider(
  fetchImpl: typeof fetch,
  options: { breakerFailureThreshold?: number } = {},
): AnthropicProvider {
  return new AnthropicProvider({
    apiKey: 'sk-ant-test',
    model: 'claude-haiku-4-5',
    fetchImpl,
    ...options,
  });
}

function sentBody(fetchImpl: ReturnType<typeof vi.fn>, call = 0): Body {
  const init = fetchImpl.mock.calls[call]?.[1] as RequestInit | undefined;
  return JSON.parse(init?.body as string) as Body;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the request the provider sends', () => {
  it('names its own model, keeps the caller schema in the system prompt, and drops think', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(textResponse('{"ok": true}')));

    await provider(fetchImpl).generate(REQUEST);

    const body = sentBody(fetchImpl);
    expect(body.model).toBe('claude-haiku-4-5');
    expect(body.temperature).toBe(0);
    expect(body.think).toBeUndefined();
    expect(body.output_config).toBeUndefined();
    expect(String(body.system)).toContain('you extract entities');
    expect(String(body.system)).toContain(JSON.stringify(SCHEMA));
    // The system message is lifted out; only the conversation turns stay in `messages`.
    expect(body.messages).toEqual([{ role: 'user', content: 'the episode text' }]);
  });

  it('sends the key and the API version as headers', async () => {
    const fetchImpl = vi.fn((..._args: unknown[]) => Promise.resolve(textResponse('{}')));

    await provider(fetchImpl).generate(REQUEST);

    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = init?.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });
});

describe('the reply the provider reads', () => {
  it('takes the last complete value when the model corrects itself', async () => {
    const reply = '```json\n{"n": 1}\n```\n\nOn reflection:\n\n```json\n{"n": 2}\n```';
    const fetchImpl = vi.fn(() => Promise.resolve(textResponse(reply)));

    await expect(provider(fetchImpl as unknown as typeof fetch).generate(REQUEST)).resolves.toEqual(
      { n: 2 },
    );
  });

  it('names a reply that carried no JSON, once the constrained retry has also failed', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(textResponse('I cannot answer that.')));

    await expect(
      provider(fetchImpl as unknown as typeof fetch).generate(REQUEST),
    ).rejects.toBeInstanceOf(AnthropicResponseError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('asks again with the schema constrained when the prompted answer will not parse', async () => {
    // A string value closed, then prose: what the model actually returns, and identical on
    // every retry of the same request.
    const spliced = '{"quote": "the first half" and then some words}';
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(textResponse(spliced))
      .mockResolvedValueOnce(textResponse('{"quote": "the first half"}'));

    const value = await provider(fetchImpl).generate(REQUEST);

    expect(value).toEqual({ quote: 'the first half' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sentBody(fetchImpl, 0).output_config).toBeUndefined();
    expect(sentBody(fetchImpl, 1).output_config).toEqual({
      format: { type: 'json_schema', schema: { ...SCHEMA, additionalProperties: false } },
    });
    // The retry constrains the answer, so it stops restating the schema as an instruction.
    expect(String(sentBody(fetchImpl, 1).system)).toBe('you extract entities');
  });

  it('closes every nested object on the constrained retry, and leaves one that states its own rule', async () => {
    const nested = {
      type: 'object',
      properties: {
        rows: {
          type: 'array',
          items: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        },
        open: { type: 'object', properties: {}, additionalProperties: true },
      },
      required: ['rows'],
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(textResponse('not json'))
      .mockResolvedValueOnce(textResponse('{"rows": []}'));

    await provider(fetchImpl).generate({ ...REQUEST, schema: nested });

    const { format } = sentBody(fetchImpl, 1).output_config as { format: { schema: Body } };
    expect(format.schema).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {
        rows: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: { name: { type: 'string' } },
            required: ['name'],
          },
        },
        open: { type: 'object', properties: {}, additionalProperties: true },
      },
      required: ['rows'],
    });
  });

  it('does not retry a caller that already asked for the constrained mode', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(textResponse('not json')));
    const constrained = new AnthropicProvider({
      apiKey: 'sk-ant-test',
      model: 'claude-haiku-4-5',
      fetchImpl,
      schemaDelivery: 'output_config',
    });

    await expect(constrained.generate(REQUEST)).rejects.toBeInstanceOf(AnthropicResponseError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('names a reply with no text block at all', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ content: [] }))));

    await expect(provider(fetchImpl as unknown as typeof fetch).generate(REQUEST)).rejects.toThrow(
      /missing text content/,
    );
  });
});

describe('failures the provider has to survive', () => {
  it('carries the status on a refusal and does not retry it', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('bad key', { status: 401 })));

    const err = await provider(fetchImpl as unknown as typeof fetch)
      .generate(REQUEST)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AnthropicRequestError);
    expect((err as AnthropicRequestError).status).toBe(401);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries a throttled answer, honouring retry-after, and returns the reply that lands', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('slow down', { status: 429, headers: { 'retry-after': '1' } }),
      )
      .mockResolvedValueOnce(textResponse('{"ok": true}'));

    const pending = provider(fetchImpl).generate(REQUEST);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('gives up after three attempts and reports the last status', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response('overloaded', { status: 529, headers: { 'retry-after': '1' } })),
    );

    const pending = provider(fetchImpl as unknown as typeof fetch)
      .generate(REQUEST)
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5_000);

    const err = await pending;
    expect((err as AnthropicRequestError).status).toBe(529);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('opens the breaker rather than paying the API for a failure that is not going away', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('bad key', { status: 401 })));
    const client = provider(fetchImpl, { breakerFailureThreshold: 2 });

    await expect(client.generate(REQUEST)).rejects.toBeInstanceOf(AnthropicRequestError);
    await expect(client.generate(REQUEST)).rejects.toBeInstanceOf(AnthropicRequestError);
    await expect(client.generate(REQUEST)).rejects.toBeInstanceOf(CircuitOpenError);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
