import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { estimateApiCost } from './api-pricing.js';
import { CircuitOpenError } from './circuit-breaker.js';
import { ERROR_BODY_LIMIT } from './errors.js';
import {
  OpenAiProvider,
  OpenAiRefusalError,
  OpenAiRequestError,
  OpenAiResponseError,
} from './openai-provider.js';
import { GenerationSpendGuard, type SpendHoldRequest, type SpendingGuard } from './spending.js';
import type { ApiCall, StructuredRequest } from './types.js';
import { openSqliteHandle, type SqliteHandle } from '../sqlite/database.js';
import { readSpendDay } from '../sqlite/spend-ledger.js';

const SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } } };

const REQUEST: StructuredRequest = {
  surface: 'cognitive',
  // Whatever the caller named: the provider substitutes the model it was built with.
  model: 'claude-haiku-4-5',
  messages: [
    { role: 'system', content: 'you extract entities' },
    { role: 'user', content: 'the episode text' },
  ],
  schema: SCHEMA,
  temperature: 0,
  think: false,
};

type Body = Record<string, unknown>;

const USAGE = {
  input_tokens: 1_000,
  input_tokens_details: { cached_tokens: 200, cache_write_tokens: 100 },
  output_tokens: 300,
  output_tokens_details: { reasoning_tokens: 120 },
  total_tokens: 1_300,
};

function answer(
  content: readonly Record<string, unknown>[],
  extra: Record<string, unknown> = {},
): Response {
  return new Response(
    JSON.stringify({
      status: 'completed',
      output: [
        { type: 'reasoning', summary: [] },
        { type: 'message', role: 'assistant', content },
      ],
      usage: USAGE,
      ...extra,
    }),
  );
}

function text(value: string): Response {
  return answer([{ type: 'output_text', text: value, annotations: [] }]);
}

function provider(
  fetchImpl: typeof fetch,
  options: Partial<ConstructorParameters<typeof OpenAiProvider>[0]> = {},
): OpenAiProvider {
  return new OpenAiProvider({ apiKey: 'sk-test', model: 'gpt-6-luna', fetchImpl, ...options });
}

function sent(
  fetchImpl: ReturnType<typeof vi.fn>,
  call = 0,
): { url: string; init: RequestInit; body: Body } {
  const [url, init] = fetchImpl.mock.calls[call] as [string, RequestInit];
  return { url, init, body: JSON.parse(init.body as string) as Body };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the request the OpenAI route sends', () => {
  it('speaks the Responses API with a bearer key and the model it was built with', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(text('{"ok": true}')));

    await provider(fetchImpl).generate(REQUEST);

    const { url, init, body } = sent(fetchImpl);
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
    expect(body.model).toBe('gpt-6-luna');
    expect(body.store).toBe(false);
  });

  it('asks for explicit caching with no breakpoint, which writes nothing to the cache', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(text('{"ok": true}')));

    await provider(fetchImpl).generate(REQUEST);

    const { body } = sent(fetchImpl);
    expect(body.prompt_cache_options).toEqual({ mode: 'explicit' });
    expect(JSON.stringify(body)).not.toContain('prompt_cache_breakpoint');
  });

  it('carries the frame, the surface instructions and the schema as instructions, and only the conversation as input', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(text('{"ok": true}')));

    await provider(fetchImpl).generate(REQUEST);

    const { body } = sent(fetchImpl);
    const instructions = body.instructions as string;
    expect(instructions).toContain('you extract entities');
    expect(instructions).toContain(JSON.stringify(SCHEMA));
    expect(body.input).toEqual([{ role: 'user', content: 'the episode text' }]);
    expect(body).not.toHaveProperty('text');
  });

  it('asks for no reasoning and keeps the temperature when the caller is not thinking', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(text('{"ok": true}')));

    await provider(fetchImpl).generate({ ...REQUEST, maxTokens: 900 });

    const { body } = sent(fetchImpl);
    expect(body.reasoning).toEqual({ effort: 'none' });
    expect(body.temperature).toBe(0);
    expect(body.max_output_tokens).toBe(900);
  });

  it('sends the configured effort and drops the temperature, which reasoning refuses, when the caller thinks', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(text('{"ok": true}')));

    await provider(fetchImpl, { reasoningEffort: 'medium' }).generate({ ...REQUEST, think: true });

    const { body } = sent(fetchImpl);
    expect(body.reasoning).toEqual({ effort: 'medium' });
    expect(body).not.toHaveProperty('temperature');
    expect(body.max_output_tokens).toBe(4096);
  });
});

describe('the answer the OpenAI route reads', () => {
  it('reads the JSON out of the message after the reasoning item', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(text('```json\n{"ok": true}\n```')));

    await expect(provider(fetchImpl).generate(REQUEST)).resolves.toEqual({ ok: true });
  });

  it('retries an answer that will not parse once, in JSON mode, and returns what that one says', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(text('here is what I found: ok'))
      .mockResolvedValueOnce(text('{"ok": false}'));

    await expect(provider(fetchImpl).generate(REQUEST)).resolves.toEqual({ ok: false });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sent(fetchImpl, 1).body.text).toEqual({ format: { type: 'json_object' } });
    // The schema stays in the instructions: JSON mode constrains the shape, not this schema.
    expect(sent(fetchImpl, 1).body.instructions as string).toContain(JSON.stringify(SCHEMA));
  });

  it('treats a cut-off answer as unreadable, retries it once, then says why', async () => {
    const cutOff = (): Response =>
      answer([], { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } });
    const fetchImpl = vi.fn(() => Promise.resolve(cutOff()));

    await expect(provider(fetchImpl).generate(REQUEST)).rejects.toThrow(
      /cut off \(max_output_tokens\)/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not retry a refusal, which the same request would get again', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(answer([{ type: 'refusal', refusal: 'I cannot help with that.' }])),
    );

    await expect(provider(fetchImpl).generate(REQUEST)).rejects.toBeInstanceOf(OpenAiRefusalError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reads a content-filter stop as a refusal rather than as a short answer', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        answer([], { status: 'incomplete', incomplete_details: { reason: 'content_filter' } }),
      ),
    );

    await expect(provider(fetchImpl).generate(REQUEST)).rejects.toBeInstanceOf(OpenAiRefusalError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('raises a response error for a message with no text at all', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(answer([])));

    await expect(provider(fetchImpl).generate(REQUEST)).rejects.toBeInstanceOf(OpenAiResponseError);
  });
});

describe('failures on the wire', () => {
  it('retries a throttled answer, honouring retry-after, and returns the reply that lands', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('slow down', { status: 429, headers: { 'retry-after': '1' } }),
      )
      .mockResolvedValueOnce(text('{"ok": true}'));

    const pending = provider(fetchImpl).generate(REQUEST);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('surfaces a refused request with its status and a capped body', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response(`invalid key ${'x'.repeat(1_000)}`, { status: 401 })),
    );

    const error = await provider(fetchImpl)
      .generate(REQUEST)
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(OpenAiRequestError);
    expect((error as OpenAiRequestError).status).toBe(401);
    expect((error as Error).message.length).toBeLessThan(ERROR_BODY_LIMIT + 60);
  });

  it('throws the caller abort, not a provider error, when the deadline passed before dispatch', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(text('{"ok": true}')));
    const controller = new AbortController();
    controller.abort();

    const error = await provider(fetchImpl)
      .generate({ ...REQUEST, signal: controller.signal })
      .catch((err: unknown) => err);

    expect((error as Error).name).toBe('AbortError');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('opens its breaker after repeated failures, so an outage stops costing every job', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('bad', { status: 400 })));
    const backend = provider(fetchImpl, { breakerFailureThreshold: 2 });

    await expect(backend.generate(REQUEST)).rejects.toBeInstanceOf(OpenAiRequestError);
    await expect(backend.generate(REQUEST)).rejects.toBeInstanceOf(OpenAiRequestError);
    await expect(backend.generate(REQUEST)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('what the OpenAI route records and holds', () => {
  let dir: string;
  let db: SqliteHandle;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-openai-spend-'));
    db = openSqliteHandle({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('records the usage with the cached and written input taken out of the ordinary count', async () => {
    const calls: ApiCall[] = [];
    const fetchImpl = vi.fn(() => Promise.resolve(text('{"ok": true}')));

    await provider(fetchImpl, { recordApiCall: (call) => calls.push(call) }).generate(REQUEST);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      model: 'gpt-6-luna',
      surface: 'cognitive',
      inputTokens: 700,
      cacheReadTokens: 200,
      cacheCreationTokens: 100,
      outputTokens: 300,
      thinkingTokens: 120,
      attempts: 1,
    });
  });

  it('records a billed answer even when its text forces the retry', async () => {
    const calls: ApiCall[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(text('not json'))
      .mockResolvedValueOnce(text('{"ok": true}'));

    await provider(fetchImpl, { recordApiCall: (call) => calls.push(call) }).generate(REQUEST);

    expect(calls).toHaveLength(2);
  });

  it('holds the bound before dispatch and settles the day at what the answer cost', async () => {
    const spending = new GenerationSpendGuard({ db, ceilingUsd: 5 });
    const calls: ApiCall[] = [];
    const fetchImpl = vi.fn(() => Promise.resolve(text('{"ok": true}')));

    await provider(fetchImpl, { spending, recordApiCall: (call) => calls.push(call) }).generate(
      REQUEST,
    );

    const day = readSpendDay(db, new Date());
    const [call] = calls;
    if (call === undefined) {
      throw new Error('the call was expected to be recorded');
    }
    expect(day.inFlight).toBe(0);
    expect(day.unpriced).toBe(0);
    expect(day.committedUsd).toBeCloseTo(estimateApiCost(call) ?? Number.NaN, 12);
  });

  it('holds at the ordinary input rate, since the body it sends cannot bill a cache write', async () => {
    const held: SpendHoldRequest[] = [];
    const spending: SpendingGuard = {
      hold: (request) => {
        held.push(request);
        return {
          hold: {
            reservationId: 'r',
            reservedUsd: 0,
            settle: () => undefined,
            release: () => undefined,
          },
        };
      },
      today: () => {
        throw new Error('not read here');
      },
    };
    const fetchImpl = vi.fn(() => Promise.resolve(text('{"ok": true}')));

    await provider(fetchImpl, { spending }).generate(REQUEST);

    expect(held).toHaveLength(1);
    expect(held[0]?.cacheWrite).toBe(false);
    expect(held[0]).not.toHaveProperty('cacheWriteTtl');
  });

  it('refuses before sending when the day cannot cover the bound, as generation being unavailable', async () => {
    const spending = new GenerationSpendGuard({ db, ceilingUsd: 0.000_001 });
    const fetchImpl = vi.fn(() => Promise.resolve(text('{"ok": true}')));

    const error = await provider(fetchImpl, { spending })
      .generate(REQUEST)
      .catch((err: unknown) => err);

    expect((error as Error).name).toBe('GenerationCeilingReachedError');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('gives the day its hold back when the request never left', async () => {
    const spending = new GenerationSpendGuard({ db, ceilingUsd: 5 });
    const fetchImpl = vi.fn(() => Promise.resolve(text('{"ok": true}')));
    const controller = new AbortController();
    controller.abort();

    await provider(fetchImpl, { spending })
      .generate({ ...REQUEST, signal: controller.signal })
      .catch(() => undefined);

    expect(readSpendDay(db, new Date()).committedUsd).toBe(0);
  });
});
