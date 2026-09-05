import { describe, expect, it } from 'vitest';

import { narrativeScale } from './narrative-scale.js';
import { NARRATIVE_MAX_SENTENCES } from './narrative.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';

describe('narrative scale', () => {
  it('reads the local route at the values the local model was measured on', () => {
    expect(narrativeScale(false, DEFAULTS.reflection)).toEqual({
      maxSourceEpisodes: 40,
      episodeChars: 2_000,
      maxSentences: NARRATIVE_MAX_SENTENCES,
    });
  });

  it('reads the keyed route at the keyed knobs', () => {
    expect(narrativeScale(true, DEFAULTS.reflection)).toEqual({
      maxSourceEpisodes: DEFAULTS.reflection.keyedNarrativeEpisodes,
      episodeChars: DEFAULTS.reflection.keyedNarrativeEpisodeChars,
      maxSentences: DEFAULTS.reflection.keyedNarrativeSentences,
    });
  });

  it('reads wider on the keyed route than on the local one', () => {
    const local = narrativeScale(false, DEFAULTS.reflection);
    const keyed = narrativeScale(true, DEFAULTS.reflection);

    expect(keyed.maxSourceEpisodes).toBeGreaterThan(local.maxSourceEpisodes);
    expect(keyed.episodeChars).toBeGreaterThan(local.episodeChars);
    expect(keyed.maxSentences).toBeGreaterThan(local.maxSentences);
  });

  it('follows the knobs a deployment set rather than the shipped table', () => {
    const tuned = { ...DEFAULTS.reflection, keyedNarrativeEpisodes: 200, maxNarrativeEpisodes: 10 };

    expect(narrativeScale(true, tuned).maxSourceEpisodes).toBe(200);
    expect(narrativeScale(false, tuned).maxSourceEpisodes).toBe(10);
  });
});
