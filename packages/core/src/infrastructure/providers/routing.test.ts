import { describe, expect, it } from 'vitest';

import {
  GENERATION_ROLES,
  remoteBannerLines,
  resolveProviderRouting,
  routingSummary,
} from './routing.js';
import type { GenerationProvider } from './types.js';
import { DEFAULTS } from '../config/defaults.js';
import type { Config } from '../config/schema.js';

const HAIKU = DEFAULTS.anthropic.model;
const LUNA = DEFAULTS.openai.model;
const EMBED_MODEL = DEFAULTS.models.embed;

function config(
  keys: { anthropic?: string; openai?: string } = {},
  providers: { recall?: GenerationProvider; reflect?: GenerationProvider } = {},
): Config {
  return {
    ...DEFAULTS,
    anthropic: { ...DEFAULTS.anthropic, apiKey: keys.anthropic ?? '' },
    openai: { ...DEFAULTS.openai, apiKey: keys.openai ?? '' },
    generation: {
      recallProvider: providers.recall ?? DEFAULTS.generation.recallProvider,
      reflectProvider: providers.reflect ?? DEFAULTS.generation.reflectProvider,
    },
  };
}

describe('the routing rule', () => {
  it('routes every generation role to the Anthropic model by default when its key is set', () => {
    const routing = resolveProviderRouting(config({ anthropic: 'sk-ant-test' }));

    expect(routing.keyPresent).toBe(true);
    for (const role of GENERATION_ROLES) {
      expect(routing.roles[role]).toEqual({
        role,
        provider: 'anthropic',
        model: HAIKU,
        available: true,
      });
    }
  });

  it('routes each role to the provider its own knob names, at that provider model', () => {
    const routing = resolveProviderRouting(
      config({ anthropic: 'sk-ant-test', openai: 'sk-test' }, { reflect: 'openai' }),
    );

    expect(routing.roles.cue).toMatchObject({ provider: 'anthropic', model: HAIKU });
    expect(routing.roles.reflect).toMatchObject({
      provider: 'openai',
      model: LUNA,
      available: true,
    });
  });

  it('never moves a role to the provider that has a key when its own has none', () => {
    const routing = resolveProviderRouting(
      config({ anthropic: 'sk-ant-test' }, { recall: 'openai' }),
    );

    expect(routing.roles.cue).toMatchObject({ provider: 'openai', available: false });
    expect(routing.roles.reflect).toMatchObject({ provider: 'anthropic', available: true });
    expect(routing.keyPresent).toBe(false);
  });

  it('makes every role unavailable with no key rather than routing it somewhere else', () => {
    const routing = resolveProviderRouting(config());

    expect(routing.keyPresent).toBe(false);
    for (const role of GENERATION_ROLES) {
      expect(routing.roles[role].available).toBe(false);
      expect(routing.roles[role].model).toBe(HAIKU);
    }
  });

  it('reads a key that is only whitespace as no key', () => {
    expect(resolveProviderRouting(config({ anthropic: '  \n' })).keyPresent).toBe(false);
    expect(
      resolveProviderRouting(config({ openai: ' \n' }, { recall: 'openai', reflect: 'openai' }))
        .keyPresent,
    ).toBe(false);
  });

  it('leaves the embedding model out of the routing question', () => {
    expect(resolveProviderRouting(config({ openai: 'sk-test' })).embedModel).toBe(EMBED_MODEL);
    expect(resolveProviderRouting(config()).embedModel).toBe(EMBED_MODEL);
  });
});

describe('what a person reads about the route', () => {
  it('summarizes each role as provider and model', () => {
    expect(
      routingSummary(
        resolveProviderRouting(
          config({ anthropic: 'sk-ant-test', openai: 'sk-test' }, { reflect: 'openai' }),
        ),
      ),
    ).toBe(`cue=anthropic:${HAIKU} reflect=openai:${LUNA}`);
  });

  it('summarizes a role with no key as queued on its provider rather than as a model it never calls', () => {
    expect(routingSummary(resolveProviderRouting(config({}, { reflect: 'openai' })))).toBe(
      'cue=queued(anthropic) reflect=queued(openai)',
    );
  });

  it('names the call classes that leave the machine, and for which API', () => {
    const banner = remoteBannerLines(
      resolveProviderRouting(
        config({ anthropic: 'sk-ant-test', openai: 'sk-test' }, { recall: 'openai' }),
      ),
    ).join('\n');

    expect(banner).toContain(`openai (${LUNA}): recall`);
    expect(banner).toContain(`anthropic (${HAIKU}): reflection extraction and session narratives`);
    expect(banner).toContain('embeddings and every graph read stay local');
  });

  it('says which key each unrouted role waits for and what still works', () => {
    const banner = remoteBannerLines(
      resolveProviderRouting(config({}, { reflect: 'openai' })),
    ).join('\n');

    expect(banner).toContain('AION_RECALL_PROVIDER=anthropic needs AION_ANTHROPIC_API_KEY');
    expect(banner).toContain('AION_REFLECT_PROVIDER=openai needs AION_OPENAI_API_KEY');
    expect(banner).toContain('capture, embeddings and every graph read still work');
    expect(banner).toContain('recall serves the existing ranking');
  });
});
