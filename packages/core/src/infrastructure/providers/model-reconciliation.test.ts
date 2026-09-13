import { describe, expect, it, vi } from 'vitest';

import { listResidentModels, reconcileResidentModels } from './model-reconciliation.js';
import { DEFAULTS } from '../config/defaults.js';

const BASE_URL = 'http://ollama.test:11434';
const EMBED = DEFAULTS.models.embed;

type Call = { path: string; body: Record<string, unknown> };

function ollama(
  resident: readonly string[],
  options: { psStatus?: number } = {},
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

    if (options.psStatus !== undefined) {
      return Promise.resolve(new Response('down', { status: options.psStatus }));
    }
    return Promise.resolve(
      new Response(JSON.stringify({ models: resident.map((name) => ({ name, size: 1024 })) })),
    );
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

describe('reconciling what Ollama holds against what this substrate needs', () => {
  it('reports the embedding model as resident and unloads nothing', async () => {
    const { calls, impl } = ollama([`${EMBED}:latest`]);

    const report = await reconcileResidentModels({
      baseUrl: BASE_URL,
      embedModel: EMBED,
      fetchImpl: impl,
    });

    expect(report.embedResident).toBe(true);
    expect(calls.map((call) => call.path)).toEqual(['/api/ps']);
    expect(report.detail).toContain(EMBED);
  });

  it('matches a bare configured name against the tag Ollama reports', async () => {
    const { impl } = ollama([`${EMBED}:latest`]);

    expect(
      (await reconcileResidentModels({ baseUrl: BASE_URL, embedModel: EMBED, fetchImpl: impl }))
        .embedResident,
    ).toBe(true);
  });

  it('says the first embed will load it when it is not resident', async () => {
    const { impl } = ollama([]);

    const report = await reconcileResidentModels({
      baseUrl: BASE_URL,
      embedModel: EMBED,
      fetchImpl: impl,
    });

    expect(report.embedResident).toBe(false);
    expect(report.detail).toContain('the first embed loads it');
  });

  // Another program's weights are not this program's to evict, so they are counted and left.
  it('names another program models as another program without touching them', async () => {
    const { calls, impl } = ollama([`${EMBED}:latest`, 'llama3:70b', 'qwen3:8b']);

    const report = await reconcileResidentModels({
      baseUrl: BASE_URL,
      embedModel: EMBED,
      fetchImpl: impl,
    });

    expect(report.resident).toContain('llama3:70b');
    expect(report.detail).toContain('belong to something else');
    expect(calls.map((call) => call.path)).toEqual(['/api/ps']);
  });

  it('reports an unreachable Ollama instead of failing the boot that called it', async () => {
    const { impl } = ollama([], { psStatus: 500 });

    const report = await reconcileResidentModels({
      baseUrl: BASE_URL,
      embedModel: EMBED,
      fetchImpl: impl,
    });

    expect(report.error).toContain('/api/ps');
    expect(report.embedResident).toBe(false);
  });
});
