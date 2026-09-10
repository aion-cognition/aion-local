import { closeSessionNarrative, type NarrativeDeps, type NarrativeOptions } from './narratives.js';
import { certifyNarrativeSupport } from '../../evidence/application/narrative-support.js';
import {
  findStaleNarratives,
  type StaleNarrative,
} from '../../infrastructure/graph/narrative-queries.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { NARRATIVE_GROUNDING } from '../domain/narrative.js';

/**
 * A one-shot repair for the narratives the free-prose writer left behind: they claim history
 * the substrate never held, and they are recall-eligible forever. Where the session still
 * holds episodes the narrative is rewritten under the grounding rule and supersedes its
 * predecessor. The `narrative_regrounding` operation drains this on the hour bucket, bounded by
 * `maintenance.narrativeCleanupBatch`.
 *
 * Where the session holds no episode this used to FORGET the narrative, on the reasoning that
 * nothing could ground a rewrite. That reasoning read a storage fact as an evidence fact: a
 * session whose raw containers have been evicted still has the records that say what those
 * sources were, and the narrative is the compressed form of exactly them. So the empty-session
 * branch now asks the manifest instead. A narrative it holds up is left standing, unrewritten
 * and unforgotten; one it can say nothing about is withheld and reported, because a suppression
 * has no reopen path and an unbound id is silence rather than absence. Nothing here forgets.
 */

export type NarrativeCleanupDeps = NarrativeDeps & {
  /** Where support is read from. The graph says what is connected; this says what is held up. */
  readonly db: SqliteHandle;
};

export type NarrativeCleanupOptions = Omit<NarrativeOptions, 'now' | 'regenerate'> & {
  readonly limit?: number;
  readonly now?: Date;
};

export type NarrativeCleanupReport = {
  readonly examined: number;
  readonly sessions: number;
  readonly regenerated: number;
  /** Narratives left standing on proved durable support rather than rewritten or suppressed. */
  readonly held: number;
  /** Narratives nothing could account for, left standing and owed a repair. */
  readonly withheld: number;
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
  deps: NarrativeCleanupDeps,
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
  let held = 0;
  let withheld = 0;
  let failed = 0;

  for (const [sessionId, group] of bySession) {
    if ((group[0]?.episodeCount ?? 0) === 0) {
      // No live Episode is a statement about storage. What each narrative rests on is a
      // statement about the records, and it is the second one that decides.
      for (const narrative of group) {
        const support = certifyNarrativeSupport(deps.db, narrative.id);
        if (support.support === 'supported') {
          held += 1;
          continue;
        }
        withheld += 1;
        deps.logger.warn(
          { sessionId, narrativeId: narrative.id, reason: support.reason },
          'narrative regrounding withheld: nothing accounts for what this narrative rests on',
        );
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

  return { examined: stale.length, sessions: bySession.size, regenerated, held, withheld, failed };
}
