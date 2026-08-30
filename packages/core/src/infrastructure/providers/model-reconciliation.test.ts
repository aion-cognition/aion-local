import { describe, expect, it, vi } from 'vitest';

import { listResidentModels, reconcileResidentModels } from './model-reconciliation.js';
import { resolveProviderRouting, type ProviderPin } from './routing.js';
import { DEFAULTS } from '../config/defaults.js';
import type { Config } from '../config/schema.js';

const BASE_URL = 'http://ollama.test:11434';

type Setup = { readonly key?: string; readonly cue?: ProviderPin; readonly reflect?: ProviderPin };

function routing(setup: Setup = {}): ReturnType<typeof resolveProviderRouting> {
  const config: Config = {
    ...DEFAULTS,
    anthropic: { ...DEFAULTS.anthropic, apiKey: setup.key ?? '' },
    routing: { cue: setup.cue ?? 'auto', reflect: setup.reflect ?? 'auto' },
  };
  return resolveProviderRouting(config);
}

type Call = { path: string; body: Record<string, unknown> };

function ollama(
  resident: readonly string[],
  options: { psStatus?: number; unloadStatus?: number } = {},
): {
  calls: Call[];
  impl: typeof fetch;
} {
  const calls: Call[] = [];
  const impl = vi.fn((url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body =
      init?.body === undefined ? {} : (JSON.parse(init.body as string) as Record<string, unknown>);
    calls.push({ path, body });

    if (path === '/api/ps') {
      if (options.psStatus !== undefined) {
        return Promise.resolve(new Response('down', { status: options.psStatus }));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ models: resident.map((name) => ({ name, size: 1024 })) })),
      );
    }
    if (options.unloadStatus !== undefined) {
      return Promise.resolve(new Response('busy', { status: options.unloadStatus }));
    }
    return Promise.resolve(new Response(JSON.stringify({ done: true })));
  });
  return { calls, impl: impl as unknown as typeof fetch };
}

describe('reading what Ollama is holding in memory', () => {
  it('names each resident model and its size', async () => {
    const { impl } = ollama(['qwen3:8b']);

    expect(await listResidentModels(BASE_URL, { fetchImpl: impl })).toEqual([
      { name: 'qwen3:8b', sizeBytes: 1024 },
    ]);
  });
});

describe('reconciling memory against the route', () => {
  it('asks Ollama nothing at all when every role is local', async () => {
    const { calls, impl } = ollama(['qwen3:8b']);

    const report = await reconcileResidentModels({
      baseUrl: BASE_URL,
      routing: routing(),
      fetchImpl: impl,
    });

    expect(report.checked).toBe(false);
    expect(calls).toEqual([]);
  });

  it('unloads a resident model whose role went remote and leaves the embed model alone', async () => {
    const { calls, impl } = ollama([DEFAULTS.models.reflect, `${DEFAULTS.models.embed}:latest`]);

    const report = await reconcileResidentModels({
      baseUrl: BASE_URL,
      routing: routing({ key: 'sk-ant-test', cue: 'ollama' }),
      fetchImpl: impl,
    });

    expect(report.evicted).toEqual([DEFAULTS.models.reflect]);
    expect(calls.map((call) => call.path)).toEqual(['/api/ps', '/api/generate']);
    expect(calls[1]?.body).toEqual({
      model: DEFAULTS.models.reflect,
      keep_alive: 0,
      stream: false,
    });
    expect(report.detail).toContain('models stay on disk');
  });

  it('matches a bare configured name against the tag Ollama reports', async () => {
    const embedRouting = routing({ key: 'sk-ant-test' });
    const { calls, impl } = ollama([DEFAULTS.models.cue, DEFAULTS.models.reflect]);

    const report = await reconcileResidentModels({
      baseUrl: BASE_URL,
      routing: embedRouting,
      fetchImpl: impl,
    });

    expect(report.evicted).toEqual([DEFAULTS.models.cue, DEFAULTS.models.reflect]);
    expect(calls.filter((call) => call.path === '/api/generate')).toHaveLength(2);
  });

  it('reports a candidate that was never loaded rather than poking Ollama for it', async () => {
    const { calls, impl } = ollama([]);

    const report = await reconcileResidentModels({
      baseUrl: BASE_URL,
      routing: routing({ key: 'sk-ant-test' }),
      fetchImpl: impl,
    });

    expect(report.evicted).toEqual([]);
    expect(report.absent).toEqual([DEFAULTS.models.cue, DEFAULTS.models.reflect]);
    expect(calls.map((call) => call.path)).toEqual(['/api/ps']);
    expect(report.detail).toContain('not in memory');
  });

  it('reports an unreachable Ollama instead of failing the boot that called it', async () => {
    const { impl } = ollama([], { psStatus: 500 });

    const report = await reconcileResidentModels({
      baseUrl: BASE_URL,
      routing: routing({ key: 'sk-ant-test' }),
      fetchImpl: impl,
    });

    expect(report.error).toContain('/api/ps');
    expect(report.evicted).toEqual([]);
  });

  it('keeps going when one unload fails and names the one that did', async () => {
    const { impl } = ollama([DEFAULTS.models.cue, DEFAULTS.models.reflect], { unloadStatus: 503 });

    const report = await reconcileResidentModels({
      baseUrl: BASE_URL,
      routing: routing({ key: 'sk-ant-test' }),
      fetchImpl: impl,
    });

    expect(report.evicted).toEqual([]);
    expect(report.error).toContain(DEFAULTS.models.cue);
    expect(report.error).toContain(DEFAULTS.models.reflect);
  });
});
