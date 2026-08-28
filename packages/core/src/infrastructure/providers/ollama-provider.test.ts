import { describe, expect, it, vi } from 'vitest';
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
      expect(JSON.parse(String(init?.body))).toEqual({
        model: 'nomic-embed-text',
        input: ['a', 'b'],
      });
      return jsonResponse({ embeddings: [[1, 2, 3], [4, 5, 6]] });
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

  it('folds case before the request, so a proper noun is not sent as an out-of-vocabulary token', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body)).input).toEqual([
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

  it('returns an empty array without a network call for no texts', async () => {
    const fetchImpl = vi.fn();
    const provider = new OllamaProvider({
      baseUrl: 'http://localhost:11434',
      embedModel: 'nomic-embed-text',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(provider.embed([])).resolves.toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws when the response omits embeddings', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const provider = new OllamaProvider({
      baseUrl: 'http://localhost:11434',
      embedModel: 'nomic-embed-text',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(provider.embed(['a'])).rejects.toThrow(/missing or mismatched/);
  });

  it('throws with the status and body on a non-ok response', async () => {
    const fetchImpl = vi.fn(async () => new Response('model not found', { status: 404 }));
    const provider = new OllamaProvider({
      baseUrl: 'http://localhost:11434',
      embedModel: 'nomic-embed-text',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(provider.embed(['a'])).rejects.toThrow(/404/);
  });
});

describe('OllamaProvider.generate', () => {
  it('posts the schema as the chat format and parses the returned JSON content', async () => {
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe('http://localhost:11434/api/chat');
      const parsed = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(parsed.model).toBe('qwen3:1.7b');
      expect(parsed.format).toEqual({ type: 'object', properties: { cues: { type: 'array' } } });
      expect(parsed.stream).toBe(false);
      expect(parsed.options).toEqual({ num_predict: 128, temperature: 0.2 });
      return jsonResponse({ message: { role: 'assistant', content: '{"cues":["a"]}' } });
    });
    const provider = new OllamaProvider({
      baseUrl: 'http://localhost:11434',
      embedModel: 'nomic-embed-text',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(
      provider.generate({
        model: 'qwen3:1.7b',
        messages: [{ role: 'user', content: 'extract cues' }],
        schema: { type: 'object', properties: { cues: { type: 'array' } } },
        maxTokens: 128,
        temperature: 0.2,
      }),
    ).resolves.toEqual({ cues: ['a'] });
  });

  it('throws when the response has no message content', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: { role: 'assistant' } }));
    const provider = new OllamaProvider({
      baseUrl: 'http://localhost:11434',
      embedModel: 'nomic-embed-text',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(
      provider.generate({
        model: 'qwen3:1.7b',
        messages: [{ role: 'user', content: 'hi' }],
        schema: {},
      }),
    ).rejects.toThrow(/missing message content/);
  });
});
