import type { EpisodeContext } from '../../infrastructure/graph/episode-context.js';

/**
 * The one capture class the generating stages decline, and the bound that decides which
 * members of it they decline.
 *
 * A subagent-stop hook pushes the subagent's last message as a single observation. Most of
 * those are a synthesis worth extracting from; the short ones are a progress line saying a
 * step finished, and a model asked to name the entities in one names the phrases in it, which
 * mints a node per progress line and an episode per step.
 *
 * The class is the capture event, never the words. Nothing here reads the text: the test is
 * which hook wrote the episode and how many bytes it carries, so a long synthesis from the
 * same hook is extracted like any other episode and a short episode from any other capture
 * path is untouched. A byte count is a size bound, not a reading of what the bytes say.
 *
 * The episode and its embedding are written either way, by intake, before any of this runs.
 * What the class decides is whether generation reads it, so the record stays recallable by
 * BM25, vector search and traversal with no structure extracted from it.
 */

export const HOOK_ORIGIN_CHANNEL = 'hook';

/** The hook event `cli/src/hook` stamps on a subagent's final-message capture. */
export const SUBAGENT_STOP_EVENT = 'subagent-stop';

/**
 * The line a declining stage records, which is what reaches the per-stage ops ledger and makes
 * the skip readable after the fact rather than inferable from an absence.
 *
 * Undefined for every episode a stage should read, which is every episode but a sub-floor
 * capture of the named class.
 */
export function generationSkipReason(
  episode: EpisodeContext,
  minChars: number,
): string | undefined {
  if (episode.originChannel !== HOOK_ORIGIN_CHANNEL) {
    return undefined;
  }
  if (episode.originEvent !== SUBAGENT_STOP_EVENT) {
    return undefined;
  }
  const bytes = Buffer.byteLength(episode.text.trim(), 'utf8');
  if (bytes >= minChars) {
    return undefined;
  }
  return (
    `${SUBAGENT_STOP_EVENT} capture of ${String(bytes)} bytes, under the ` +
    `${String(minChars)} byte extraction floor: the episode and its embedding stand, ` +
    'generation is skipped'
  );
}
