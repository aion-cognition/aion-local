import { closeSessionNarrative, type NarrativeDeps, type NarrativeOptions } from './narratives.js';
import {
  findStaleNarratives,
  forgetNarrative,
  type StaleNarrative,
} from '../../infrastructure/graph/narrative-queries.js';
import { NARRATIVE_GROUNDING } from '../domain/narrative.js';

/**
 * A one-shot repair for the narratives the free-prose writer left behind: they claim history
 * the substrate never held, and they are recall-eligible forever. Where the session still
 * holds episodes the narrative is rewritten under the grounding rule and supersedes its
 * predecessor; where it holds none, nothing can ground a rewrite and the old node is
 * forgotten: suppressed, still readable through `as_of`. There is no automatic maintenance
 * pass yet, so this runs by hand.
 */

export type NarrativeCleanupOptions = Omit<NarrativeOptions, 'now' | 'regenerate'> & {
  readonly limit?: number;
  readonly now?: Date;
};

export type NarrativeCleanupReport = {
  readonly examined: number;
  readonly sessions: number;
  readonly regenerated: number;
  readonly forgotten: number;
  readonly failed: number;
};

/** One pass covers a dev substrate; a larger one is repeated passes, not a longer transaction. */
export const DEFAULT_CLEANUP_LIMIT = 500;

function groupBySession(narratives: readonly StaleNarrative[]): Map<string, StaleNarrative[]> {
  const bySession = new Map<string, StaleNarrative[]>();
  for (const narrative of narratives) {
    const group = bySession.get(narrative.sessionId);
    if (group === undefined) {
      bySession.set(narrative.sessionId, [narrative]);
      continue;
    }
    group.push(narrative);
  }
  return bySession;
}

export async function cleanupNarratives(
  deps: NarrativeDeps,
  options: NarrativeCleanupOptions = {},
): Promise<NarrativeCleanupReport> {
  const now = options.now ?? new Date();
  const stale = await findStaleNarratives(
    deps.driver,
    NARRATIVE_GROUNDING,
    options.limit ?? DEFAULT_CLEANUP_LIMIT,
  );
  const bySession = groupBySession(stale);

  let regenerated = 0;
  let forgotten = 0;
  let failed = 0;

  for (const [sessionId, group] of bySession) {
    if ((group[0]?.episodeCount ?? 0) === 0) {
      for (const narrative of group) {
        const closed = await forgetNarrative(deps.driver, narrative.id, now);
        forgotten += closed ? 1 : 0;
      }
      continue;
    }

    const result = await closeSessionNarrative(deps, sessionId, {
      ...options,
      now,
      regenerate: true,
    });
    if (result.status === 'created') {
      regenerated += group.length;
      continue;
    }
    deps.logger.warn(
      { sessionId, status: result.status, summary: result.summary },
      'narrative regeneration did not replace the standing narrative',
    );
    failed += group.length;
  }

  return { examined: stale.length, sessions: bySession.size, regenerated, forgotten, failed };
}
