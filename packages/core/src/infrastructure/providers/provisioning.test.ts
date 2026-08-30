import { describe, expect, it, vi } from 'vitest';
import { EmbedDimensionMismatchError, ModelPullError, OllamaUnreachableError } from './errors.js';
import { checkOllamaReachable, provisionOllama, type ProvisionEvent } from './provisioning.js';

function ndjson(lines: readonly Record<string, unknown>[]): Response {
  const body = lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
  return new Response(body, { status: 200 });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const PULL_SUCCESS = [{ status: 'pulling manifest' }, { status: 'success' }];

describe('checkOllamaReachable', () => {
  it('resolves when the version endpoint responds ok', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ version: '0.24.0' }));
    await expect(
      checkOllamaReachable('http://localhost:11434', { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toBeUndefined();
  });

  it('throws OllamaUnreachableError with both host install commands when the request fails', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const err = await checkOllamaReachable('http://localhost:11434', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(OllamaUnreachableError);
    expect((err as Error).message).toMatch(/brew install ollama/);
    expect((err as Error).message).toMatch(/curl -fsSL https:\/\/ollama\.com\/install\.sh/);
  });

  it('throws OllamaUnreachableError when the response is not ok', async () => {
    const fetchImpl = vi.fn(async () => new Response('bad gateway', { status: 502 }));
    await expect(
      checkOllamaReachable('http://localhost:11434', { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toBeInstanceOf(OllamaUnreachableError);
  });
});

describe('provisionOllama', () => {
  it('pulls each unique model once, verifies embed and chat, and reports events in order', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const body = init?.body === undefined ? {} : (JSON.parse(String(init.body)) as Record<string, unknown>);
      calls.push(`${path}:${String(body.model)}`);

      if (path === '/api/version') {
        return jsonResponse({ version: '0.24.0' });
      }
      if (path === '/api/pull') {
        return ndjson(PULL_SUCCESS);
      }
      if (path === '/api/embed') {
        return jsonResponse({ embeddings: [new Array<number>(768).fill(0.1)] });
      }
      if (path === '/api/chat') {
        return jsonResponse({ done: true, message: { role: 'assistant', content: '' } });
      }
      throw new Error(`unexpected path: ${path}`);
    });

    const events: ProvisionEvent[] = [];
    await provisionOllama(
      {
        baseUrl: 'http://localhost:11434',
        embedModel: 'nomic-embed-text',
        embedDimension: 768,
        chatModels: ['qwen3:1.7b', 'qwen3:8b'],
      },
      { fetchImpl: fetchImpl as unknown as typeof fetch, onEvent: (e) => events.push(e) },
    );

    expect(calls).toEqual([
      '/api/version:undefined',
      '/api/pull:nomic-embed-text',
      '/api/pull:qwen3:1.7b',
      '/api/pull:qwen3:8b',
      '/api/embed:nomic-embed-text',
      '/api/chat:qwen3:1.7b',
      '/api/chat:qwen3:8b',
    ]);
    expect(events[0]).toEqual({ type: 'reachable' });
    expect(events.filter((e) => e.type === 'pull_done').map((e) => (e as { model: string }).model)).toEqual([
      'nomic-embed-text',
      'qwen3:1.7b',
      'qwen3:8b',
    ]);
    expect(events.at(-1)).toEqual({ type: 'verify_done', model: 'qwen3:8b', kind: 'chat' });
  });

  it('dedupes the pull and chat-verify calls when both roles name the same model', async () => {
    const pullCalls: string[] = [];
    const chatCalls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const body = init?.body === undefined ? {} : (JSON.parse(String(init.body)) as Record<string, unknown>);

      if (path === '/api/version') {
        return jsonResponse({ version: '0.24.0' });
      }
      if (path === '/api/pull') {
        pullCalls.push(String(body.model));
        return ndjson(PULL_SUCCESS);
      }
      if (path === '/api/embed') {
        return jsonResponse({ embeddings: [new Array<number>(768).fill(0.1)] });
      }
      if (path === '/api/chat') {
        chatCalls.push(String(body.model));
        return jsonResponse({ done: true, message: { role: 'assistant', content: '' } });
      }
      throw new Error(`unexpected path: ${path}`);
    });

    await provisionOllama(
      {
        baseUrl: 'http://localhost:11434',
        embedModel: 'nomic-embed-text',
        embedDimension: 768,
        chatModels: ['qwen3:1.7b', 'qwen3:1.7b'],
      },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(pullCalls).toEqual(['nomic-embed-text', 'qwen3:1.7b']);
    expect(chatCalls).toEqual(['qwen3:1.7b']);
  });

  it('pulls the embed model alone when every generation role routes to Anthropic', async () => {
    const pullCalls: string[] = [];
    const chatCalls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const body = init?.body === undefined ? {} : (JSON.parse(String(init.body)) as Record<string, unknown>);

      if (path === '/api/version') {
        return jsonResponse({ version: '0.24.0' });
      }
      if (path === '/api/pull') {
        pullCalls.push(String(body.model));
        return ndjson(PULL_SUCCESS);
      }
      if (path === '/api/embed') {
        return jsonResponse({ embeddings: [new Array<number>(768).fill(0.1)] });
      }
      if (path === '/api/chat') {
        chatCalls.push(String(body.model));
        return jsonResponse({ done: true, message: { role: 'assistant', content: '' } });
      }
      throw new Error(`unexpected path: ${path}`);
    });

    await provisionOllama(
      {
        baseUrl: 'http://localhost:11434',
        embedModel: 'nomic-embed-text',
        embedDimension: 768,
        chatModels: [],
      },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(pullCalls).toEqual(['nomic-embed-text']);
    expect(chatCalls).toEqual([]);
  });

  it('throws ModelPullError when the pull stream reports an error line', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const path = new URL(String(url)).pathname;
      if (path === '/api/version') {
        return jsonResponse({ version: '0.24.0' });
      }
      if (path === '/api/pull') {
        return ndjson([{ status: 'pulling manifest' }, { error: 'model not found' }]);
      }
      throw new Error(`unexpected path: ${path}`);
    });

    const err = await provisionOllama(
      {
        baseUrl: 'http://localhost:11434',
        embedModel: 'nomic-embed-text',
        embedDimension: 768,
        chatModels: ['qwen3:1.7b', 'qwen3:8b'],
      },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ModelPullError);
    expect((err as Error).message).toMatch(/model not found/);
  });

  it('throws EmbedDimensionMismatchError when the embed round-trip returns the wrong dimension', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const path = new URL(String(url)).pathname;
      if (path === '/api/version') {
        return jsonResponse({ version: '0.24.0' });
      }
      if (path === '/api/pull') {
        return ndjson(PULL_SUCCESS);
      }
      if (path === '/api/embed') {
        return jsonResponse({ embeddings: [[1, 2, 3]] });
      }
      throw new Error(`unexpected path: ${path}`);
    });

    const err = await provisionOllama(
      {
        baseUrl: 'http://localhost:11434',
        embedModel: 'nomic-embed-text',
        embedDimension: 768,
        chatModels: ['qwen3:1.7b', 'qwen3:8b'],
      },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EmbedDimensionMismatchError);
    expect((err as Error).message).toMatch(/768/);
    expect((err as Error).message).toMatch(/AION_EMBED_DIMENSION/);
  });
});
