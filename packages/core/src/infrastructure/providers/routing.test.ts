import { describe, expect, it } from 'vitest';

import {
  evictableModels,
  localChatModels,
  modelsToPull,
  remoteBannerLines,
  resolveProviderRouting,
  routingSummary,
  unbackedPins,
  type ProviderPin,
} from './routing.js';
import { DEFAULTS } from '../config/defaults.js';
import type { Config } from '../config/schema.js';

const HAIKU = DEFAULTS.anthropic.model;
const CUE_MODEL = DEFAULTS.models.cue;
const REFLECT_MODEL = DEFAULTS.models.reflect;
const EMBED_MODEL = DEFAULTS.models.embed;

type Setup = {
  readonly key?: string;
  readonly cue?: ProviderPin;
  readonly reflect?: ProviderPin;
  readonly cueModel?: string;
  readonly reflectModel?: string;
};

function config(setup: Setup = {}): Config {
  return {
    ...DEFAULTS,
    models: {
      ...DEFAULTS.models,
      cue: setup.cueModel ?? CUE_MODEL,
      reflect: setup.reflectModel ?? REFLECT_MODEL,
    },
    anthropic: { ...DEFAULTS.anthropic, apiKey: setup.key ?? '' },
    routing: { cue: setup.cue ?? 'auto', reflect: setup.reflect ?? 'auto' },
  };
}

describe('the routing matrix', () => {
  it('keeps every role local when no key is set', () => {
    const routing = resolveProviderRouting(config());

    expect(routing.keyPresent).toBe(false);
    expect(routing.roles.cue).toMatchObject({
      provider: 'ollama',
      model: CUE_MODEL,
      reason: 'local-default',
    });
    expect(routing.roles.reflect).toMatchObject({ provider: 'ollama', model: REFLECT_MODEL });
    expect(localChatModels(routing)).toEqual([CUE_MODEL, REFLECT_MODEL]);
    expect(evictableModels(routing)).toEqual([]);
  });

  it('routes every generation role to the Anthropic model when the key is set', () => {
    const routing = resolveProviderRouting(config({ key: 'sk-ant-test' }));

    expect(routing.roles.cue).toMatchObject({ provider: 'anthropic', model: HAIKU, reason: 'key' });
    expect(routing.roles.reflect).toMatchObject({
      provider: 'anthropic',
      model: HAIKU,
      reason: 'key',
    });
    // The local tag travels with the route, which is what reconciliation unloads.
    expect(routing.roles.reflect.localModel).toBe(REFLECT_MODEL);
    expect(localChatModels(routing)).toEqual([]);
  });

  it('honours a per-role pin back to Ollama with the key still set', () => {
    const routing = resolveProviderRouting(config({ key: 'sk-ant-test', cue: 'ollama' }));

    expect(routing.roles.cue).toMatchObject({
      provider: 'ollama',
      model: CUE_MODEL,
      reason: 'pinned-local',
    });
    expect(routing.roles.reflect).toMatchObject({ provider: 'anthropic', model: HAIKU });
    expect(localChatModels(routing)).toEqual([CUE_MODEL]);
  });

  it('honours a per-role pin to Anthropic while the other role stays local', () => {
    const routing = resolveProviderRouting(
      config({ key: 'sk-ant-test', cue: 'ollama', reflect: 'anthropic' }),
    );

    expect(routing.roles.reflect).toMatchObject({ provider: 'anthropic', reason: 'pinned-remote' });
    expect(routing.roles.cue.provider).toBe('ollama');
  });

  it('runs a role pinned to Anthropic locally when no key backs the pin, and says so', () => {
    const routing = resolveProviderRouting(config({ reflect: 'anthropic' }));

    expect(routing.roles.reflect).toMatchObject({
      provider: 'ollama',
      model: REFLECT_MODEL,
      reason: 'pin-without-key',
    });
    expect(unbackedPins(routing).map((route) => route.role)).toEqual(['reflect']);
    expect(evictableModels(routing)).toEqual([]);
  });

  it('reports no unbacked pin when the key backs it', () => {
    expect(
      unbackedPins(resolveProviderRouting(config({ key: 'sk-ant-test', reflect: 'anthropic' }))),
    ).toEqual([]);
  });
});

describe('what routing asks init and reconciliation to do', () => {
  it('pulls the embed model alone once every generation role is remote', () => {
    const routing = resolveProviderRouting(config({ key: 'sk-ant-test' }));

    expect(modelsToPull(routing)).toEqual([EMBED_MODEL]);
    expect(evictableModels(routing)).toEqual([CUE_MODEL, REFLECT_MODEL]);
  });

  it('pulls the embed model and whatever chat model is still local', () => {
    const routing = resolveProviderRouting(config({ key: 'sk-ant-test', cue: 'ollama' }));

    expect(modelsToPull(routing)).toEqual([EMBED_MODEL, CUE_MODEL]);
    expect(evictableModels(routing)).toEqual([REFLECT_MODEL]);
  });

  it('never evicts a model another role still routes to locally', () => {
    const routing = resolveProviderRouting(
      config({ key: 'sk-ant-test', cue: 'ollama', cueModel: 'qwen3:8b', reflectModel: 'qwen3:8b' }),
    );

    expect(routing.roles.reflect.provider).toBe('anthropic');
    expect(evictableModels(routing)).toEqual([]);
  });

  it('never evicts the embedding model, even when a role names it', () => {
    const routing = resolveProviderRouting(
      config({ key: 'sk-ant-test', reflectModel: EMBED_MODEL }),
    );

    expect(evictableModels(routing)).toEqual([CUE_MODEL]);
  });
});

describe('what a person reads about the route', () => {
  it('summarizes each role as provider and model', () => {
    expect(
      routingSummary(resolveProviderRouting(config({ key: 'sk-ant-test', cue: 'ollama' }))),
    ).toBe(`cue=ollama:${CUE_MODEL} reflect=anthropic:${HAIKU}`);
  });

  it('prints no banner on a fully local install', () => {
    expect(remoteBannerLines(resolveProviderRouting(config()))).toEqual([]);
  });

  it('names the call classes that leave the machine and the ones that do not', () => {
    const banner = remoteBannerLines(resolveProviderRouting(config({ key: 'sk-ant-test' }))).join(
      '\n',
    );

    expect(banner).toContain('Anthropic API');
    expect(banner).toContain(HAIKU);
    expect(banner).toContain('recall cue extraction');
    expect(banner).toContain('reflection extraction and session narratives');
    expect(banner).toContain('embeddings and every graph read stay local');
  });

  it('names only the remote role when one is pinned local', () => {
    const banner = remoteBannerLines(
      resolveProviderRouting(config({ key: 'sk-ant-test', cue: 'ollama' })),
    ).join('\n');

    expect(banner).toContain('reflection extraction');
    expect(banner).not.toContain('recall cue extraction');
  });
});
