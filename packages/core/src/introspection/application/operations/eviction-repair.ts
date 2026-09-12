import type { Driver } from 'neo4j-driver';

import type { PublicationCoordinator } from '../../../infrastructure/publication/coordinator.js';
import type { SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import {
  ageObsoleteSurvivorWork,
  listRunnableSurvivorWork,
} from '../../../infrastructure/sqlite/eviction-manifests.js';
import {
  publishContextVectorSync,
  type ContextVectorSyncResult,
} from '../../../reflection/application/context-vector-sync.js';

/**
 * The work an acknowledged eviction left behind: retained neighbours whose stored context was
 * computed from a neighbourhood that no longer exists.
 *
 * The existing staleness scan cannot find them. It looks for a neighbour edge whose stamp has
 * moved, and the edge did not move — it was removed, and with it the row the scan would have
 * matched. A node whose LAST vectored neighbour goes that way keeps a context vector forever,
 * derived from a neighbourhood of nothing. So the affected ids are carried explicitly, from the
 * manifest through durable tasks a committed receipt made runnable, and each one is recomputed
 * against the neighbourhood it has now.
 *
 * The recomputation itself is `context_vector_sync`, which is where every property of it now
 * lives: the node set and each member's neighbourhood revision bound before the guard is asked
 * for, the revision rechecked under it, the zero-neighbour clear narrowed to a neighbourhood the
 * guard proved empty, the sync stamped, and a durable receipt naming the exact set. This pass
 * nominates and reports; it no longer writes.
 *
 * What it still owns is the obligations. Nothing is discharged by an attempt: the operation's
 * acknowledgment settles a task only where the receipt says the node was written, and a member
 * it could only name a hold for stays owed. Deferral belongs to the same acknowledgment for the
 * same reason.
 *
 * The pass also ages the obligations a discarded attempt parked. Those are the other end of the
 * same life: prepared, never released, adoptable only by an attempt naming the same generation, so
 * once the generation is replaced they are finished without ever having said so.
 */

export type SurvivorRepairDeps = {
  readonly driver: Driver;
  readonly db: SqliteHandle;
  /** Where the recomputation publishes. Without one the pass nominates nothing and says so. */
  readonly publications: PublicationCoordinator;
  readonly now: Date;
};

export type SurvivorRepairReport = {
  readonly attempted: number;
  readonly recomputed: number;
  readonly cleared: number;
  /** Stamped as examined over a neighbourhood carrying no positive weight; the vector is untouched. */
  readonly stamped: number;
  /** Settled without a recomputation: the survivor is gone, or carries no context vector at all. */
  readonly classified: number;
  /** Left owed under a named hold. */
  readonly deferred: number;
  /** Parked obligations aged out of re-adoptable because their generation is past. */
  readonly lapsed: number;
  /** Why nothing was published, where the guard refused the batch whole. */
  readonly refusal?: string;
};

const NOTHING = {
  attempted: 0,
  recomputed: 0,
  cleared: 0,
  stamped: 0,
  classified: 0,
  deferred: 0,
  lapsed: 0,
} satisfies SurvivorRepairReport;

/** The two holds the operation settles rather than defers, counted as the pass's own outcome. */
const SETTLED_HOLDS = new Set(['node_absent', 'node_not_vectored']);

function reportOf(
  attempted: number,
  lapsed: number,
  result: ContextVectorSyncResult,
): SurvivorRepairReport {
  const settled = result.holds.filter((hold) => SETTLED_HOLDS.has(hold.reason)).length;
  return {
    attempted,
    recomputed: result.recomputed.length,
    cleared: result.cleared.length,
    stamped: result.stamped.length,
    classified: settled,
    deferred: result.holds.length - settled,
    lapsed,
  };
}

export async function repairSurvivors(
  deps: SurvivorRepairDeps,
  limit: number,
): Promise<SurvivorRepairReport> {
  if (limit <= 0) {
    return NOTHING;
  }
  // Ahead of the runnable read, and outside the empty-backlog return below it: a parked
  // obligation is inert exactly when nothing is runnable, so a sweep that only ran on a busy
  // tick would never meet the rows it exists for.
  const lapsed = ageObsoleteSurvivorWork(deps.db, limit);
  const tasks = listRunnableSurvivorWork(deps.db, deps.now, limit);
  if (tasks.length === 0) {
    return { ...NOTHING, lapsed };
  }
  const outcome = await publishContextVectorSync(deps, {
    basis: 'survivor_repair',
    // No one subject: a batch spans every eviction whose obligations came due together, and the
    // member's own work row is what names which eviction owes it.
    subject: null,
    members: tasks.map((task) => ({ id: task.nodeId, workId: task.workId })),
  });
  if (outcome.status !== 'published') {
    return { ...NOTHING, attempted: tasks.length, lapsed, refusal: outcome.reason };
  }
  return reportOf(tasks.length, lapsed, outcome.result);
}
