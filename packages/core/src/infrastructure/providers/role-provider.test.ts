import { describe, expect, it, vi } from 'vitest';

import { GenerationUnavailableError } from './errors.js';
import { ProviderRouter, type GenerationEvent } from './role-provider.js';
import type { Provider } from './types.js';
import { DEFAULTS } from '../config/defaults.js';
import type { Config } from '../config/schema.js';

const SCHEMA = { type: 'object' };

function config(key = ''): Config {
  return {
    ...DEFAULTS,
    ollama: { ...DEFAULTS.ollama, url: 'http://ollama.test:11434' },
    anthropic: { ...DEFAULTS.anthropic, apiKey: key },
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
    return Promise.resolve(
      new Response(JSON.stringify({ content: [{ type: 'text', text: '{"from": "anthropic"}' }] })),
    );
  });
  return { calls, impl: impl as unknown as typeof fetch };
}

function request(model: string): Parameters<ReturnType<ProviderRouter['forRole']>['generate']>[0] {
  return {
    surface: 'probe',
    model,
    messages: [{ role: 'user', content: 'hello' }],
    schema: SCHEMA,
  };
}

describe('what each role generates against', () => {
  it('sends both roles to Anthropic under the configured model when the key is set', async () => {
    const { calls, impl } = recordingFetch();
    const router = new ProviderRouter({ config: config('sk-ant-test'), fetchImpl: impl });

    const cue = await router.forRole('cue').generate(request('whatever the caller named'));
    const reflect = await router.forRole('reflect').generate(request('whatever the caller named'));

    expect(cue).toEqual({ from: 'anthropic' });
    expect(reflect).toEqual({ from: 'anthropic' });
    expect(calls.map((call) => call.url)).toEqual([
      'https://api.anthropic.com/v1/messages',
      'https://api.anthropic.com/v1/messages',
    ]);
    // The caller's model name is substituted, so no call site carries a second model knob.
    expect(calls.map((call) => call.body.model)).toEqual([
      DEFAULTS.anthropic.model,
      DEFAULTS.anthropic.model,
    ]);
  });

  it('refuses to generate with no key rather than reaching anything else', async () => {
    const { calls, impl } = recordingFetch();
    const router = new ProviderRouter({ config: config(), fetchImpl: impl });

    await expect(router.forRole('reflect').generate(request('m'))).rejects.toBeInstanceOf(
      GenerationUnavailableError,
    );
    expect(calls).toEqual([]);
  });

  it('names the surface in the refusal, so a queued job records what could not run', async () => {
    const { impl } = recordingFetch();
    const router = new ProviderRouter({ config: config(), fetchImpl: impl });

    const err: Error = await router
      .forRole('reflect')
      .generate(request('m'))
      .then(
        () => {
          throw new Error('the call was expected to reject');
        },
        (error: unknown) => error as Error,
      );

    expect(err.message).toContain('probe');
    expect(err.message).toContain('AION_ANTHROPIC_API_KEY');
  });

  it('embeds locally with a key and without one', async () => {
    for (const key of ['sk-ant-test', '']) {
      const { calls, impl } = recordingFetch();
      const router = new ProviderRouter({ config: config(key), fetchImpl: impl });

      await router.forRole('reflect').embed(['the episode text']);

      expect(calls[0]?.url).toBe('http://ollama.test:11434/api/embed');
      expect(calls[0]?.body.model).toBe(DEFAULTS.models.embed);
    }
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
      config: config('sk-ant-test'),
      fetchImpl: impl,
      onGeneration: (event) => events.push(event),
    });

    await router.forRole('cue').generate(request('m'));
    await router.forRole('reflect').generate(request('m'));

    expect(events).toEqual([
      expect.objectContaining({
        role: 'cue',
        provider: 'anthropic',
        model: DEFAULTS.anthropic.model,
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

  it('carries the resolved provider on the role provider', () => {
    const { impl } = recordingFetch();
    const router = new ProviderRouter({ config: config('sk-ant-test'), fetchImpl: impl });

    const reflect: Provider = router.forRole('reflect');

    expect(reflect.route?.provider).toBe('anthropic');
  });

  it('reports a failed generation rather than swallowing it', async () => {
    const impl = vi.fn(() => Promise.resolve(new Response('nope', { status: 400 })));
    const events: GenerationEvent[] = [];
    const router = new ProviderRouter({
      config: config('sk-ant-test'),
      fetchImpl: impl,
      onGeneration: (event) => events.push(event),
    });

    await expect(router.forRole('cue').generate(request('m'))).rejects.toThrow();

    expect(events).toEqual([
      expect.objectContaining({ role: 'cue', provider: 'anthropic', ok: false }),
    ]);
  });

  // A substrate that never called anything has no failure rate, and counting the refusal would
  // give it one for the life of the install.
  it('counts no generation at all when there is no key', async () => {
    const { impl } = recordingFetch();
    const events: GenerationEvent[] = [];
    const router = new ProviderRouter({
      config: config(),
      fetchImpl: impl,
      onGeneration: (event) => events.push(event),
    });

    await expect(router.forRole('cue').generate(request('m'))).rejects.toThrow();

    expect(events).toEqual([]);
  });
});
