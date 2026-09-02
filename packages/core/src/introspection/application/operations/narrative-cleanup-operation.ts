import type { Driver } from 'neo4j-driver';

import { supersedeInTransaction } from '../../../infrastructure/graph/bitemporal.js';
import { inWriteTransaction } from '../../../infrastructure/graph/connection.js';
import { lockNodeInTransaction } from '../../../infrastructure/graph/locks.js';
import {
  findDuplicateNarrativeSessions,
  findOrphanedNarratives,
  readOpenNarrativeVersionsInTransaction,
  type DuplicateNarrativeGroup,
  type DuplicateNarrativeVersion,
} from '../../../infrastructure/graph/narrative-cleanup-queries.js';
import { forgetNarrative } from '../../../infrastructure/graph/narrative-queries.js';
import type { IntrospectionOperation, OperationOutcome } from '../../domain/operation.js';

/**
 * The two narrative pathologies that need no model call to repair. A duplicate is two open
 * narratives left standing after a crash landed between a write and its supersession, and an
 * orphan is an open narrative whose session has since had every one of its episodes forgotten.
 * Neither is rare enough on a long-running substrate to leave for the next session close: a
 * session that stopped being written to stops triggering the ordinary repair path too.
 *
 * The grounding-stale regeneration path (`reflection/application/narrative-cleanup.ts`) is out
 * of scope here because it calls a model to rewrite the narrative body, which neither of these
 * two repairs needs. `narrative_regrounding` is the operation that drives that path.
 */

export const NARRATIVE_CLEANUP_OPERATION = 'narrative_cleanup';

export const NARRATIVE_DUPLICATE_METHOD = 'introspection_narrative_duplicate';
const NARRATIVE_DUPLICATE_SIGNALS = ['duplicate_narrative'];

/**
 * Standing relevance, like `memory_decay`: neither pathology this operation repairs has a
 * live gauge in the snapshot (the graph collector's `staleNarratives` counts a different
 * thing, the grounding-revision backlog this operation does not touch), so it reaches the
 * urgency threshold on waiting time, the same "scheduled cadence" memory_decay documents.
 * Wiring it to `staleNarratives` anyway would make the engine expect a count this operation
 * cannot move, and score every run against a metric it never had a hand in.
 */
export const NARRATIVE_CLEANUP_STANDING_RELEVANCE = 0.15;

/** Highest coverage wins; version breaks a tie the same coverage could otherwise leave open; id is the last resort. */
function keepNewest(versions: readonly DuplicateNarrativeVersion[]): DuplicateNarrativeVersion {
  const [newest] = [...versions].sort(
    (left, right) =>
      right.coverageCount - left.coverageCount ||
      right.version - left.version ||
      left.id.localeCompare(right.id),
  );
  if (newest === undefined) {
    // The caller only reaches here with a duplicate group, and a duplicate group is
    // never fewer than two versions (the query that finds one requires it).
    throw new Error('keepNewest requires at least one version');
  }
  return newest;
}

async function closeDuplicates(
  driver: Driver,
  limit: number,
  now: Date,
): Promise<{ sessions: number; closed: number }> {
  const groups: readonly DuplicateNarrativeGroup[] = await findDuplicateNarrativeSessions(
    driver,
    limit,
  );
  let closed = 0;
  for (const group of groups) {
    // One transaction per session, session locked first, group re-read under the lock. The
    // keeper is chosen from what is open at write time, so a concurrent close of the version
    // this scan liked cannot leave the session with every version closed.
    closed += await inWriteTransaction(driver, async (tx) => {
      await lockNodeInTransaction(tx, group.sessionId, now);
      const versions = await readOpenNarrativeVersionsInTransaction(tx, group.sessionId);
      if (versions.length < 2) {
        return 0;
      }
      const keep = keepNewest(versions);
      let closedHere = 0;
      for (const version of versions) {
        if (version.id === keep.id) {
          continue;
        }
        await supersedeInTransaction(tx, {
          oldId: version.id,
          newId: keep.id,
          now,
          signals: NARRATIVE_DUPLICATE_SIGNALS,
          provenance: [NARRATIVE_DUPLICATE_METHOD],
        });
        closedHere += 1;
      }
      return closedHere;
    });
  }
  return { sessions: groups.length, closed };
}

export function narrativeCleanupOperation(): IntrospectionOperation {
  return {
    name: NARRATIVE_CLEANUP_OPERATION,
    bucket: 'hour',
    relevance: () => NARRATIVE_CLEANUP_STANDING_RELEVANCE,
    run: async (ctx): Promise<OperationOutcome> => {
      const batch = ctx.config.maintenance.narrativeCleanupBatch;
      const duplicates = await closeDuplicates(ctx.driver, batch, ctx.now);

      const orphans = await findOrphanedNarratives(ctx.driver, batch);
      let forgotten = 0;
      for (const orphan of orphans) {
        if (await forgetNarrative(ctx.driver, orphan.id, ctx.now)) {
          forgotten += 1;
        }
      }

      const processed = duplicates.sessions + orphans.length;
      const affected = duplicates.closed + forgotten;
      return {
        status: affected === 0 ? 'noop' : 'applied',
        itemsProcessed: processed,
        itemsAffected: affected,
        detail:
          `${String(duplicates.closed)} duplicate narrative(s) superseded across ` +
          `${String(duplicates.sessions)} session(s), ${String(forgotten)} orphan(s) forgotten`,
      };
    },
  };
}
