import { afterEach, describe, expect, it, vi } from 'vitest';

import { AnthropicRequestError, AnthropicResponseError } from './anthropic-errors.js';
import { AnthropicProvider } from './anthropic-provider.js';
import { CircuitOpenError } from './circuit-breaker.js';
import { ERROR_BODY_LIMIT } from './errors.js';
import type { StructuredRequest } from './types.js';

const SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } } };

const REQUEST: StructuredRequest = {
  // Whatever the caller named: the provider substitutes the model it was built with.
  model: 'the-caller-model',
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

/** The surface's own block: the second one, after the shared frame. */
function taskBlock(body: Body): string {
  const system = body.system as readonly { text: string }[] | undefined;
  const block = system?.[1];
  if (block === undefined) {
    throw new Error('expected a task block after the frame');
  }
  return block.text;
}

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Thinking is a request field on this route, not a flag it drops. Haiku 4.5 takes only the
 * manual extended-thinking mode, so the number is the configuration, the API refuses a budget
 * under 1,024 or at or above `max_tokens`, and it refuses any temperature but 1 beside it.
 */
describe('the extended thinking the provider configures', () => {
  it('sends an explicit budget when the caller asks the model to reason', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(textResponse('{"ok": true}')));

    await provider(fetchImpl).generate({ ...REQUEST, think: true });

    const body = sentBody(fetchImpl);
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
    expect(body.think).toBeUndefined();
  });

  it('drops the caller temperature, which the API accepts only at 1 beside thinking', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(textResponse('{"ok": true}')));

    await provider(fetchImpl).generate({ ...REQUEST, think: true, temperature: 0 });

    expect(sentBody(fetchImpl)).not.toHaveProperty('temperature');
  });

  it('keeps the temperature when the caller is not reasoning', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(textResponse('{"ok": true}')));

    await provider(fetchImpl).generate({ ...REQUEST, think: false, temperature: 0 });

    expect(sentBody(fetchImpl).temperature).toBe(0);
  });

  it('clamps the budget under the ceiling it has to share with the answer', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(textResponse('{"ok": true}')));

    await provider(fetchImpl).generate({ ...REQUEST, think: true, maxTokens: 3000 });

    expect(sentBody(fetchImpl).thinking).toEqual({ type: 'enabled', budget_tokens: 1976 });
  });

  it('sends no thinking at all where the ceiling cannot hold the API minimum', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(textResponse('{"ok": true}')));

    await provider(fetchImpl).generate({ ...REQUEST, think: true, maxTokens: 1200 });

    expect(sentBody(fetchImpl)).not.toHaveProperty('thinking');
  });

  it('reads the answer out of the text block that follows the reasoning', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            content: [
              { type: 'thinking', thinking: 'the queue is the larger backlog', signature: 's' },
              { type: 'text', text: '{"ok": true}' },
            ],
          }),
        ),
      ),
    );

    await expect(provider(fetchImpl).generate({ ...REQUEST, think: true })).resolves.toEqual({
      ok: true,
    });
  });

  it('says so when the reasoning filled the ceiling and left no answer', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            content: [{ type: 'thinking', thinking: 'still weighing it', signature: 's' }],
          }),
        ),
      ),
    );

    await expect(provider(fetchImpl).generate({ ...REQUEST, think: true })).rejects.toThrow(
      /reasoning and no answer/,
    );
  });
});

describe('the request the provider sends', () => {
  it('names its own model, keeps the caller schema in the system prompt, and drops think', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(textResponse('{"ok": true}')));

    await provider(fetchImpl).generate(REQUEST);

    const body = sentBody(fetchImpl);
    expect(body.model).toBe('claude-haiku-4-5');
    expect(body.think).toBeUndefined();
    expect(body.output_config).toBeUndefined();
    // Two blocks: the shared frame, then the surface's own text with its schema after it.
    // Neither is marked, because the frame is far under the cache floor and
    // `anthropic-cache.ts` carries the measurement behind that.
    expect(taskBlock(body)).toContain('you extract entities');
    expect(taskBlock(body)).toContain(JSON.stringify(SCHEMA));
    // The system message is lifted out; only the conversation turns stay in `messages`.
    expect(body.messages).toEqual([{ role: 'user', content: 'the episode text' }]);
  });

  // The newer model families reject `temperature` with a 400, and the model is an operator
  // knob, so an unasked-for default would fail every generation on those.
  it('sends temperature only when the caller asked for one', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(textResponse('{"ok": true}')));

    await provider(fetchImpl).generate(REQUEST);
    expect(sentBody(fetchImpl)).not.toHaveProperty('temperature');

    await provider(fetchImpl).generate({ ...REQUEST, temperature: 0.4 });
    expect(sentBody(fetchImpl, 1).temperature).toBe(0.4);
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
    expect(taskBlock(sentBody(fetchImpl, 1))).toBe('you extract entities');
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

  // `deadline-signal.ts` promises a shutdown never waits out a model call, and the backoff
  // sleep is the one place that promise had no effect.
  it('unwinds a throttle backoff as soon as the caller aborts', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(() => {
      controller.abort();
      return Promise.resolve(
        new Response('slow down', { status: 429, headers: { 'retry-after': '30' } }),
      );
    });

    await expect(
      provider(fetchImpl as unknown as typeof fetch).generate({
        ...REQUEST,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/abort/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  }, 2_000);

  it('opens the breaker rather than paying the API for a failure that is not going away', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('bad key', { status: 401 })));
    const client = provider(fetchImpl, { breakerFailureThreshold: 2 });

    await expect(client.generate(REQUEST)).rejects.toBeInstanceOf(AnthropicRequestError);
    await expect(client.generate(REQUEST)).rejects.toBeInstanceOf(AnthropicRequestError);
    await expect(client.generate(REQUEST)).rejects.toBeInstanceOf(CircuitOpenError);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

/**
 * The error message is what roughly a dozen `{ err }` call sites write to the JSONL log, and a
 * reflection prompt embeds episode and claim text. A provider that echoes the request back in
 * its error body would put that content in every one of those lines.
 */
describe('what a request error carries into the logs', () => {
  const LEAKY_BODY = Array.from(
    { length: 60 },
    (_, line) =>
      `{"line": ${String(line)}, "echo": "the episode text a reflection prompt embedded"}`,
  ).join('\n');

  it('caps a multi-kilobyte body and collapses it to one line', async () => {
    expect(LEAKY_BODY.length).toBeGreaterThan(3_000);
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(LEAKY_BODY, { status: 400 })));

    const err = (await provider(fetchImpl as unknown as typeof fetch)
      .generate(REQUEST)
      .catch((e: unknown) => e)) as AnthropicRequestError;

    expect(err).toBeInstanceOf(AnthropicRequestError);
    expect(err.message).not.toContain('\n');
    expect(err.message).toContain('400');
    expect(err.message.length).toBeLessThan(ERROR_BODY_LIMIT + 80);
    // The tail, which is where an uncapped message would keep spilling the body.
    expect(err.message).not.toContain('"line": 59');
  });
});
