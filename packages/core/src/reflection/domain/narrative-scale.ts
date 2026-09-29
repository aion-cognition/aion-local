import type { Config } from '../../infrastructure/config/schema.js';

/**
 * How much of a session one synthesis reads and how long its answer runs. The numbers are sized
 * for a hosted model (Haiku first, and GPT-6 Luna's window is larger) and come from the knob
 * table, so a deployment moves them without a second rule appearing here.
 */
export type NarrativeScale = {
  readonly maxSourceEpisodes: number;
  readonly episodeChars: number;
  readonly maxSentences: number;
};

/**
 * One rule for every synthesis source: the session narrative, the day and week rollups, and the
 * subject consolidation all read the same sizes. There used to be a second, smaller set for a
 * local generation route; every provider the service builds is hosted now.
 */
export function narrativeScale(reflection: Config['reflection']): NarrativeScale {
  return {
    maxSourceEpisodes: reflection.keyedNarrativeEpisodes,
    episodeChars: reflection.keyedNarrativeEpisodeChars,
    maxSentences: reflection.keyedNarrativeSentences,
  };
}
