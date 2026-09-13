import { describe, expect, it } from 'vitest';

import {
  GENERATION_ROLES,
  remoteBannerLines,
  resolveProviderRouting,
  routingSummary,
} from './routing.js';
import { DEFAULTS } from '../config/defaults.js';
import type { Config } from '../config/schema.js';

const HAIKU = DEFAULTS.anthropic.model;
const EMBED_MODEL = DEFAULTS.models.embed;

function config(key = ''): Config {
  return { ...DEFAULTS, anthropic: { ...DEFAULTS.anthropic, apiKey: key } };
}

describe('the routing rule', () => {
  it('routes every generation role to the Anthropic model when the key is set', () => {
    const routing = resolveProviderRouting(config('sk-ant-test'));

    expect(routing.keyPresent).toBe(true);
    for (const role of GENERATION_ROLES) {
      expect(routing.roles[role]).toEqual({ role, model: HAIKU, available: true });
    }
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
    expect(resolveProviderRouting(config('  \n')).keyPresent).toBe(false);
  });

  it('leaves the embedding model out of the routing question', () => {
    expect(resolveProviderRouting(config('sk-ant-test')).embedModel).toBe(EMBED_MODEL);
    expect(resolveProviderRouting(config()).embedModel).toBe(EMBED_MODEL);
  });
});

describe('what a person reads about the route', () => {
  it('summarizes each role as provider and model', () => {
    expect(routingSummary(resolveProviderRouting(config('sk-ant-test')))).toBe(
      `cue=anthropic:${HAIKU} reflect=anthropic:${HAIKU}`,
    );
  });

  it('summarizes a keyless substrate as queued rather than as a model it never calls', () => {
    expect(routingSummary(resolveProviderRouting(config()))).toBe('cue=queued reflect=queued');
  });

  it('names the call classes that leave the machine and the ones that do not', () => {
    const banner = remoteBannerLines(resolveProviderRouting(config('sk-ant-test'))).join('\n');

    expect(banner).toContain('Anthropic API');
    expect(banner).toContain(HAIKU);
    expect(banner).toContain('recall cue extraction');
    expect(banner).toContain('reflection extraction and session narratives');
    expect(banner).toContain('embeddings and every graph read stay local');
  });

  it('says what a keyless install still does and what waits', () => {
    const banner = remoteBannerLines(resolveProviderRouting(config())).join('\n');

    expect(banner).toContain('no AION_ANTHROPIC_API_KEY is set');
    expect(banner).toContain('capture, embeddings and every graph read still work');
    expect(banner).toContain('Generation work queues');
    expect(banner).toContain('raw query');
  });
});
