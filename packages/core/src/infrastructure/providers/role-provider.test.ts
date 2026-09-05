import { describe, expect, it, vi } from 'vitest';

import { ProviderRouter, type GenerationEvent } from './role-provider.js';
import type { ProviderPin } from './routing.js';
import type { Provider } from './types.js';
import { DEFAULTS } from '../config/defaults.js';
import type { Config } from '../config/schema.js';

const SCHEMA = { type: 'object' };

type Setup = { readonly key?: string; readonly cue?: ProviderPin; readonly reflect?: ProviderPin };

function config(setup: Setup = {}): Config {
  return {
    ...DEFAULTS,
    ollama: { ...DEFAULTS.ollama, url: 'http://ollama.test:11434' },
    anthropic: { ...DEFAULTS.anthropic, apiKey: setup.key ?? '' },
    routing: { cue: setup.cue ?? 'auto', reflect: setup.reflect ?? 'auto' },
  };
}

/** Answers both APIs in the one shape each of them returns, and records where the call went. */
function recordingFetch(): {
  calls: { url: string; body: Record<string, unknown> }[];
  impl: typeof fetch;
} {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const impl = vi.fn((url: string | URL, init?: RequestInit) => {
    const target = String(url);
    calls.push({
      url: target,
      body:
        init?.body === undefined
          ? {}
          : (JSON.parse(init.body as string) as Record<string, unknown>),
    });
    if (target.includes('/api/embed')) {
      return Promise.resolve(new Response(JSON.stringify({ embeddings: [[0.1, 0.2]] })));
    }
    if (target.includes('anthropic.com')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ content: [{ type: 'text', text: '{"from": "anthropic"}' }] }),
        ),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ message: { content: '{"from": "ollama"}' } })),
    );
  });
  return { calls, impl: impl as unknown as typeof fetch };
}

function request(model: string): Parameters<ReturnType<ProviderRouter['forRole']>['generate']>[0] {
  return { model, messages: [{ role: 'user', content: 'hello' }], schema: SCHEMA };
}

describe('what each role generates against', () => {
  it('sends both roles to Ollama with their own models when no key is set', async () => {
    const { calls, impl } = recordingFetch();
    const router = new ProviderRouter({ config: config(), fetchImpl: impl });

    await router.forRole('cue').generate(request(DEFAULTS.models.cue));
    await router.forRole('reflect').generate(request(DEFAULTS.models.reflect));

    expect(calls.map((call) => call.url)).toEqual([
      'http://ollama.test:11434/api/chat',
      'http://ollama.test:11434/api/chat',
    ]);
    expect(calls.map((call) => call.body.model)).toEqual([
      DEFAULTS.models.cue,
      DEFAULTS.models.reflect,
    ]);
  });

  it('sends both roles to Anthropic under the configured model when the key is set', async () => {
    const { calls, impl } = recordingFetch();
    const router = new ProviderRouter({ config: config({ key: 'sk-ant-test' }), fetchImpl: impl });

    const answer = await router.forRole('reflect').generate(request(DEFAULTS.models.reflect));

    expect(answer).toEqual({ from: 'anthropic' });
    expect(calls[0]?.url).toContain('api.anthropic.com');
    expect(calls[0]?.body.model).toBe(DEFAULTS.anthropic.model);
  });

  it('splits the roles when one is pinned back to Ollama', async () => {
    const { calls, impl } = recordingFetch();
    const router = new ProviderRouter({
      config: config({ key: 'sk-ant-test', cue: 'ollama' }),
      fetchImpl: impl,
    });

    await router.forRole('cue').generate(request(DEFAULTS.models.cue));
    await router.forRole('reflect').generate(request(DEFAULTS.models.reflect));

    expect(calls[0]?.url).toContain('ollama.test');
    expect(calls[1]?.url).toContain('anthropic.com');
  });

  it('embeds locally under every route', async () => {
    const { calls, impl } = recordingFetch();
    const router = new ProviderRouter({ config: config({ key: 'sk-ant-test' }), fetchImpl: impl });

    await router.forRole('reflect').embed(['the episode text']);

    expect(calls[0]?.url).toBe('http://ollama.test:11434/api/embed');
    expect(calls[0]?.body.model).toBe(DEFAULTS.models.embed);
  });

  it('threads the keep-alive knob into the embed request', async () => {
    const { calls, impl } = recordingFetch();
    const base = config();
    const router = new ProviderRouter({
      config: { ...base, ollama: { ...base.ollama, embedKeepAlive: 300 } },
      fetchImpl: impl,
    });

    await router.forRole('cue').embed(['the episode text']);

    expect(calls[0]?.body.keep_alive).toBe(300);
  });

  it('hands one role the same provider every time it is asked', () => {
    const { impl } = recordingFetch();
    const router = new ProviderRouter({ config: config(), fetchImpl: impl });

    expect(router.forRole('cue')).toBe(router.forRole('cue'));
    expect(router.forRole('cue')).not.toBe(router.forRole('reflect'));
  });
});

describe('the telemetry a caller reads the route from', () => {
  it('reports the role, the provider, and the model each generation used', async () => {
    const { impl } = recordingFetch();
    const events: GenerationEvent[] = [];
    const router = new ProviderRouter({
      config: config({ key: 'sk-ant-test', cue: 'ollama' }),
      fetchImpl: impl,
      onGeneration: (event) => events.push(event),
    });

    await router.forRole('cue').generate(request(DEFAULTS.models.cue));
    await router.forRole('reflect').generate(request(DEFAULTS.models.reflect));

    expect(events).toEqual([
      expect.objectContaining({
        role: 'cue',
        provider: 'ollama',
        model: DEFAULTS.models.cue,
        ok: true,
      }),
      expect.objectContaining({
        role: 'reflect',
        provider: 'anthropic',
        model: DEFAULTS.anthropic.model,
        ok: true,
      }),
    ]);
  });

  it('carries the resolved provider on the role provider under a keyed config', () => {
    const { impl } = recordingFetch();
    const router = new ProviderRouter({ config: config({ key: 'sk-ant-test' }), fetchImpl: impl });

    const reflect: Provider = router.forRole('reflect');

    expect(reflect.route?.provider).toBe('anthropic');
  });

  it('carries the resolved provider on the role provider under a keyless config', () => {
    const { impl } = recordingFetch();
    const router = new ProviderRouter({ config: config(), fetchImpl: impl });

    const reflect: Provider = router.forRole('reflect');

    expect(reflect.route?.provider).toBe('ollama');
  });

  it('reports a failed generation rather than swallowing it', async () => {
    const impl = vi.fn(() => Promise.resolve(new Response('nope', { status: 500 })));
    const events: GenerationEvent[] = [];
    const router = new ProviderRouter({
      config: config(),
      fetchImpl: impl,
      onGeneration: (event) => events.push(event),
    });

    await expect(router.forRole('cue').generate(request(DEFAULTS.models.cue))).rejects.toThrow();

    expect(events).toEqual([
      expect.objectContaining({ role: 'cue', provider: 'ollama', ok: false }),
    ]);
  });
});
