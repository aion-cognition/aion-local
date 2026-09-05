import { NARRATIVE_MAX_SENTENCES } from './narrative.js';
import type { Config } from '../../infrastructure/config/schema.js';

/**
 * How much of a session one synthesis reads and how long its answer runs. The local numbers are
 * what qwen3:8b was measured on; the keyed ones are what Haiku takes in one call. Both sets come
 * from the knob table, so a deployment moves either without a second rule appearing here.
 */
export type NarrativeScale = {
  readonly maxSourceEpisodes: number;
  readonly episodeChars: number;
  readonly maxSentences: number;
};

/**
 * One rule for every synthesis source: the session narrative, the day and week rollups, and the
 * subject consolidation all size themselves off the route their generation resolved to.
 * `remote` is `provider.route?.provider === 'anthropic'` at the call site, and an absent route
 * reads as local, so a test fake and a bare `OllamaProvider` get the small-model numbers.
 */
export function narrativeScale(remote: boolean, reflection: Config['reflection']): NarrativeScale {
  if (remote) {
    return {
      maxSourceEpisodes: reflection.keyedNarrativeEpisodes,
      episodeChars: reflection.keyedNarrativeEpisodeChars,
      maxSentences: reflection.keyedNarrativeSentences,
    };
  }
  return {
    maxSourceEpisodes: reflection.maxNarrativeEpisodes,
    episodeChars: reflection.maxNarrativeEpisodeChars,
    maxSentences: NARRATIVE_MAX_SENTENCES,
  };
}
