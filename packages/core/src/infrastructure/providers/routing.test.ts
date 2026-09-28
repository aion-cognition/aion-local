import { describe, expect, it } from 'vitest';

import {
  GENERATION_ROLES,
  remoteBannerLines,
  resolveProviderRouting,
  routingSummary,
  routingWarnings,
} from './routing.js';
import type { GenerationProvider } from './types.js';
import { DEFAULTS } from '../config/defaults.js';
import type { Config } from '../config/schema.js';

const HAIKU = DEFAULTS.anthropic.model;
const LUNA = DEFAULTS.openai.model;
const EMBED_MODEL = DEFAULTS.models.embed;

function config(
  keys: { anthropic?: string; openai?: string } = {},
  provider?: GenerationProvider,
): Config {
  return {
    ...DEFAULTS,
    anthropic: { ...DEFAULTS.anthropic, apiKey: keys.anthropic ?? '' },
    openai: { ...DEFAULTS.openai, apiKey: keys.openai ?? '' },
    generation: { provider: provider ?? DEFAULTS.generation.provider },
  };
}

describe('the routing rule', () => {
  it('runs every role on Anthropic when nothing selects a provider, as installs always have', () => {
    const routing = resolveProviderRouting(config({ anthropic: 'sk-ant-test' }));

    expect(routing.provider).toBe('anthropic');
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

  it('runs every role on OpenAI at the OpenAI model when that is the selection', () => {
    const routing = resolveProviderRouting(config({ openai: 'sk-test' }, 'openai'));

    for (const role of GENERATION_ROLES) {
      expect(routing.roles[role]).toMatchObject({
        provider: 'openai',
        model: LUNA,
        available: true,
      });
    }
  });

  it('needs only the selected provider key, and never moves to the provider that has one', () => {
    expect(resolveProviderRouting(config({ openai: 'sk-test' }, 'openai')).keyPresent).toBe(true);

    const routing = resolveProviderRouting(config({ anthropic: 'sk-ant-test' }, 'openai'));
    expect(routing.keyPresent).toBe(false);
    expect(routing.roles.cue).toMatchObject({ provider: 'openai', available: false });
  });

  it('reads a key that is only whitespace as no key', () => {
    expect(resolveProviderRouting(config({ anthropic: '  \n' })).keyPresent).toBe(false);
    expect(resolveProviderRouting(config({ openai: ' \n' }, 'openai')).keyPresent).toBe(false);
  });

  it('leaves the embedding model out of the routing question', () => {
    expect(resolveProviderRouting(config({ openai: 'sk-test' }, 'openai')).embedModel).toBe(
      EMBED_MODEL,
    );
    expect(resolveProviderRouting(config()).embedModel).toBe(EMBED_MODEL);
  });
});

describe('what a person reads about the route', () => {
  it('summarizes each role as provider and model', () => {
    expect(routingSummary(resolveProviderRouting(config({ openai: 'sk-test' }, 'openai')))).toBe(
      `cue=openai:${LUNA} reflect=openai:${LUNA}`,
    );
  });

  it('summarizes a provider with no key as queued rather than as a model it never calls', () => {
    expect(routingSummary(resolveProviderRouting(config({}, 'openai')))).toBe(
      'cue=queued(openai) reflect=queued(openai)',
    );
  });

  it('names the one API every hosted call class goes to, batched refresh included', () => {
    const banner = remoteBannerLines(
      resolveProviderRouting(config({ openai: 'sk-test' }, 'openai')),
    ).join('\n');

    expect(banner).toContain(`generation leaves this machine for openai (${LUNA})`);
    expect(banner).toContain('recall (candidate assessment');
    expect(banner).toContain('reflection extraction and session narratives');
    expect(banner).toContain('batched description refresh');
    expect(banner).toContain('embeddings and every graph read stay local');
    expect(banner).not.toContain('anthropic');
  });

  it('says which key the selection waits for and what still works', () => {
    const banner = remoteBannerLines(resolveProviderRouting(config({}, 'openai'))).join('\n');

    expect(banner).toContain('AION_GENERATION_PROVIDER=openai needs AION_OPENAI_API_KEY');
    expect(banner).toContain('capture, embeddings and every graph read still work');
    expect(banner).toContain('recall serves the existing ranking');
  });

  it('warns at boot about a missing selected key or an unpriced model, and nothing else', () => {
    const unpriced = config({ openai: 'sk-test' }, 'openai');

    expect(
      routingWarnings(resolveProviderRouting(config({ openai: 'sk-test' }, 'openai'))),
    ).toEqual([]);
    expect(
      routingWarnings(
        resolveProviderRouting({ ...unpriced, openai: { ...unpriced.openai, model: 'gpt-x' } }),
      ),
    ).toEqual([expect.stringContaining('openai:gpt-x, which has no price on record')]);
    expect(routingWarnings(resolveProviderRouting(config({}, 'openai')))).toEqual([
      expect.stringContaining('AION_GENERATION_PROVIDER=openai needs AION_OPENAI_API_KEY'),
    ]);
  });
});
