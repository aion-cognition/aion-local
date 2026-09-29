import { describe, expect, it, vi } from 'vitest';

import { ERROR_BODY_LIMIT, OllamaRequestError } from './errors.js';
import { OllamaProvider } from './ollama-provider.js';

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('OllamaProvider.embed', () => {
  it('posts to /api/embed and returns the vectors in order', async () => {
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe('http://localhost:11434/api/embed');
      expect(JSON.parse(init?.body as string)).toEqual({
        model: 'nomic-embed-text',
        input: ['a', 'b'],
      });
      return jsonResponse({
        embeddings: [
          [1, 2, 3],
          [4, 5, 6],
        ],
      });
    });
    const provider = new OllamaProvider({
      baseUrl: 'http://localhost:11434/',
      embedModel: 'nomic-embed-text',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(provider.embed(['a', 'b'])).resolves.toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
  });

  it('sends the configured keep_alive so the server holds the model loaded between calls', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      expect(JSON.parse(init?.body as string).keep_alive).toBe(-1);
      return jsonResponse({ embeddings: [[1]] });
    });
    const provider = new OllamaProvider({
      baseUrl: 'http://localhost:11434',
      embedModel: 'nomic-embed-text',
      embedKeepAlive: -1,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await provider.embed(['a']);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('folds case before the request, so a proper noun is not sent as an out-of-vocabulary token', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      expect(JSON.parse(init?.body as string).input).toEqual([
        'redis',
        'thandiwe baptiste',
        'postgres (tool): the graph store',
      ]);
      return jsonResponse({ embeddings: [[1], [2], [3]] });
    });
    const provider = new OllamaProvider({
      baseUrl: 'http://localhost:11434',
      embedModel: 'nomic-embed-text',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await provider.embed(['Redis', 'Thandiwe Baptiste', 'Postgres (tool): the graph store']);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('caps an input to the token ceiling budget before sending it', async () => {
    const longText = 'a'.repeat(9000);
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const sent = JSON.parse(init?.body as string).input as string[];
      expect((sent[0] ?? '').length).toBe(2046);
      expect(sent[1]).toBe('short');
      return jsonResponse({ embeddings: [[1], [2]] });
    });
    const provider = new OllamaProvider({
      baseUrl: 'http://localhost:11434',
      embedModel: 'nomic-embed-text',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await provider.embed([longText, 'short']);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('caps against the configured model, so a wider window is not spent at the narrow budget', async () => {
    const longText = 'a'.repeat(9000);
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const sent = JSON.parse(init?.body as string).input as string[];
      expect((sent[0] ?? '').length).toBe(8190);
      return jsonResponse({ embeddings: [[1]] });
    });
    const provider = new OllamaProvider({
      baseUrl: 'http://localhost:11434',
      embedModel: 'snowflake-arctic-embed2',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await provider.embed([longText]);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('holds a model outside the table to the narrow budget', async () => {
    const longText = 'a'.repeat(9000);
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const sent = JSON.parse(init?.body as string).input as string[];
      expect((sent[0] ?? '').length).toBe(2046);
      return jsonResponse({ embeddings: [[1]] });
    });
    const provider = new OllamaProvider({
      baseUrl: 'http://localhost:11434',
      embedModel: 'some-model-nobody-measured',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await provider.embed([longText]);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('returns an empty array without a network call for no texts', async () => {
    const fetchImpl = vi.fn();
    const provider = new OllamaProvider({
      baseUrl: 'http://localhost:11434',
      embedModel: 'nomic-embed-text',
      fetchImpl,
    });

    await expect(provider.embed([])).resolves.toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws when the response omits embeddings', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const provider = new OllamaProvider({
      baseUrl: 'http://localhost:11434',
      embedModel: 'nomic-embed-text',
      fetchImpl,
    });

    await expect(provider.embed(['a'])).rejects.toThrow(/missing or mismatched/);
  });

  it('throws with the status and body on a non-ok response', async () => {
    const fetchImpl = vi.fn(async () => new Response('model not found', { status: 404 }));
    const provider = new OllamaProvider({
      baseUrl: 'http://localhost:11434',
      embedModel: 'nomic-embed-text',
      fetchImpl,
    });

    await expect(provider.embed(['a'])).rejects.toThrow(/404/);
  });
});

/**
 * Ollama's own refusal of an input its runner cannot fit, which fails every input in the request.
 * The scripted server refuses any input longer than `fits` and embeds each other one as its length.
 */
function overflowServer(fits: number) {
  const sent: string[][] = [];
  const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
    const input = JSON.parse(init?.body as string).input as string[];
    sent.push(input);
    if (input.some((text) => text.length > fits)) {
      return jsonResponse(
        { error: 'the input length exceeds the context length' },
        { status: 400 },
      );
    }
    return jsonResponse({ embeddings: input.map((text) => [text.length]) });
  });
  return { sent, fetchImpl: fetchImpl as unknown as typeof fetch };
}

describe('an input Ollama refuses as longer than its window', () => {
  it('embeds the rest unchanged and the refused one from a prefix that fits', async () => {
    const { sent, fetchImpl } = overflowServer(3_000);
    const provider = new OllamaProvider({
      baseUrl: 'http://localhost:11434',
      embedModel: 'snowflake-arctic-embed2',
      fetchImpl,
    });

    const vectors = await provider.embed(['first', 'x'.repeat(9_000), 'last']);

    // The cap, then half of it, then half again: 8190, 4095, 2047.
    expect(vectors).toEqual([[5], [2_047], [4]]);
    expect(sent.map((input) => input.map((text) => text.length))).toEqual([
      [5, 8_190, 4],
      [5],
      [8_190],
      [4_095],
      [2_047],
      [4],
    ]);
  });

  it('throws rather than answer for an input refused however short it gets', async () => {
    const { fetchImpl } = overflowServer(0);
    const provider = new OllamaProvider({
      baseUrl: 'http://localhost:11434',
      embedModel: 'nomic-embed-text',
      fetchImpl,
    });

    const err = await provider.embed(['anything']).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(OllamaRequestError);
    expect((err as OllamaRequestError).status).toBe(400);
  });

  it('does not retry a refusal that is not about length', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: 'model "nope" not found, try pulling it first' }, { status: 400 }),
    );
    const provider = new OllamaProvider({
      baseUrl: 'http://localhost:11434',
      embedModel: 'nope',
      fetchImpl,
    });

    await expect(provider.embed(['a', 'b'])).rejects.toBeInstanceOf(OllamaRequestError);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('does not shorten an input whose one-at-a-time re-send fails for another reason', async () => {
    const overflow = overflowServer(3_000);
    let reloading = true;
    // The runner reloads between the refused batch and the first re-send, which fits.
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const input = JSON.parse(init?.body as string).input as string[];
      if (input.length === 1 && reloading) {
        reloading = false;
        overflow.sent.push(input);
        return new Response('llama runner process has terminated', { status: 500 });
      }
      return overflow.fetchImpl(url, init);
    });
    const provider = new OllamaProvider({
      baseUrl: 'http://localhost:11434',
      embedModel: 'snowflake-arctic-embed2',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const err = await provider.embed(['first', 'x'.repeat(9_000)]).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(OllamaRequestError);
    expect((err as OllamaRequestError).status).toBe(500);
    expect(overflow.sent.map((input) => input.map((text) => text.length))).toEqual([
      [5, 8_190],
      [5],
    ]);
  });
});

/**
 * The error message is what roughly a dozen `{ err }` call sites write to the JSONL log, and the
 * text handed to the embedder is episode and claim text. A provider that echoes the request back
 * in its error body would put that content in every one of those lines.
 */
describe('what a request error carries into the logs', () => {
  const LEAKY_BODY = Array.from(
    { length: 60 },
    (_, line) =>
      `{"line": ${String(line)}, "echo": "the episode text a reflection prompt embedded"}`,
  ).join('\n');

  it('caps a multi-kilobyte body and collapses it to one line', async () => {
    expect(LEAKY_BODY.length).toBeGreaterThan(3_000);
    const fetchImpl = vi.fn(async () => new Response(LEAKY_BODY, { status: 500 }));
    const provider = new OllamaProvider({
      baseUrl: 'http://localhost:11434',
      embedModel: 'nomic-embed-text',
      fetchImpl,
    });

    const err = (await provider
      .embed(['the episode text'])
      .catch((e: unknown) => e)) as OllamaRequestError;

    expect(err).toBeInstanceOf(OllamaRequestError);
    expect(err.status).toBe(500);
    expect(err.message).not.toContain('\n');
    expect(err.message.length).toBeLessThan(ERROR_BODY_LIMIT + 80);
    // The tail, which is where an uncapped message would keep spilling the body.
    expect(err.message).not.toContain('"line": 59');
  });
});
