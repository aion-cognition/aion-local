import { describe, expect, it } from 'vitest';

import { narrativeScale } from './narrative-scale.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';

describe('narrative scale', () => {
  it('reads the narrative knobs', () => {
    expect(narrativeScale(DEFAULTS.reflection)).toEqual({
      maxSourceEpisodes: DEFAULTS.reflection.keyedNarrativeEpisodes,
      episodeChars: DEFAULTS.reflection.keyedNarrativeEpisodeChars,
      maxSentences: DEFAULTS.reflection.keyedNarrativeSentences,
    });
  });

  it('follows the knobs a deployment set rather than the shipped table', () => {
    const tuned = { ...DEFAULTS.reflection, keyedNarrativeEpisodes: 200 };

    expect(narrativeScale(tuned).maxSourceEpisodes).toBe(200);
  });
});
