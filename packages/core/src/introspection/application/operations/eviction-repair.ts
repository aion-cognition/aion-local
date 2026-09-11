import type { Driver } from 'neo4j-driver';

import { findNeighborContentVectors } from '../../../infrastructure/graph/context-vector-queries.js';
import {
  clearContextVectorSync,
  markContextVectorSynced,
  writeContextVectorSync,
} from '../../../infrastructure/graph/context-vector-sync.js';
import { readNeighborhoodRevisionsOf } from '../../../infrastructure/graph/episode-eviction.js';
import type { SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import {
  deferSurvivorWork,
  listRunnableSurvivorWork,
  type SurvivorTask,
} from '../../../infrastructure/sqlite/eviction-manifests.js';
import { completeSourceWork } from '../../../infrastructure/sqlite/processing-generations.js';
import { computeContextVectors } from '../../../reflection/domain/context-vector.js';

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
 * The zero-neighbour outcome is the case that needed an explicit decision. `computeContextVectors`
 * returns no entry for a node with no positively-weighted vectored neighbour, which reads exactly
 * like a node the pass never looked at. Here it means the context is gone, so the vector is
 * cleared and the sync stamped — but only behind a reading the pass can certify complete. An
 * unreadable neighbourhood never clears anything.
 *
 * Nothing is discharged by an attempt. A neighbourhood that moved between the read and the write
 * dates the task forward and leaves it owed, because a stamp written over an unseen generation is
 * a claim that the recomputation covered a graph it never saw.
 */

export type SurvivorRepairDeps = {
  readonly driver: Driver;
  readonly db: SqliteHandle;
  readonly now: Date;
};

export type SurvivorRepairReport = {
  readonly attempted: number;
  readonly recomputed: number;
  readonly cleared: number;
  readonly deferred: number;
};

/** A moved neighbourhood comes back on the ordinary cadence, not immediately and not never. */
const RETRY_DELAY_MS = 15 * 60 * 1000;

const NOTHING: SurvivorRepairReport = { attempted: 0, recomputed: 0, cleared: 0, deferred: 0 };

function acknowledge(
  deps: SurvivorRepairDeps,
  task: SurvivorTask,
  reason: string,
  revision: string,
): void {
  completeSourceWork(
    deps.db,
    task.workId,
    { outcome: 'complete', reason, proof: { neighborhoodRevision: revision } },
    deps.now,
  );
}

export async function repairSurvivors(
  deps: SurvivorRepairDeps,
  limit: number,
): Promise<SurvivorRepairReport> {
  if (limit <= 0) {
    return NOTHING;
  }
  const tasks = listRunnableSurvivorWork(deps.db, deps.now, limit);
  if (tasks.length === 0) {
    return NOTHING;
  }
  const ids = tasks.map((task) => task.nodeId);
  const before = await readNeighborhoodRevisionsOf(deps.driver, ids);
  const neighbors = await findNeighborContentVectors(deps.driver, ids, deps.now);
  const computed = new Map(
    computeContextVectors(neighbors).map((entry) => [entry.id, entry] as const),
  );
  // Re-read after the neighbourhood was consumed rather than before it: the comparison has to
  // span the read the computation was taken over, which is what makes an unchanged answer mean
  // the computation saw the graph it is about to be stamped against.
  const after = await readNeighborhoodRevisionsOf(deps.driver, ids);

  const write: { id: string; vector: readonly number[]; neighborCount: number }[] = [];
  const clear: string[] = [];
  const stable: SurvivorTask[] = [];
  let deferred = 0;
  for (const task of tasks) {
    const current = after.get(task.nodeId);
    if (current === undefined) {
      // The survivor itself is gone. It owes nothing a recomputation could deliver, and a task
      // bound to it can never be satisfied, so it is completed with the reason rather than left
      // to be retried forever.
      acknowledge(deps, task, 'survivor_absent', '');
      continue;
    }
    if (before.get(task.nodeId) !== current) {
      deferSurvivorWork(deps.db, task.workId, new Date(deps.now.getTime() + RETRY_DELAY_MS));
      deferred += 1;
      continue;
    }
    const entry = computed.get(task.nodeId);
    stable.push(task);
    if (entry === undefined) {
      clear.push(task.nodeId);
    } else {
      write.push(entry);
    }
  }
  const written = new Set(await writeContextVectorSync(deps.driver, write, deps.now));
  const emptied = new Set(await clearContextVectorSync(deps.driver, clear, deps.now));
  // A node the writer could not reach is stamped so the ordinary scan does not meet it first
  // every tick; its task stays owed, because the stamp is not the recomputation.
  const missed = stable
    .map((task) => task.nodeId)
    .filter((id) => !written.has(id) && !emptied.has(id));
  await markContextVectorSynced(deps.driver, missed, deps.now);
  for (const task of stable) {
    const revision = after.get(task.nodeId) ?? '';
    if (written.has(task.nodeId)) {
      acknowledge(deps, task, 'context_vector_recomputed', revision);
    } else if (emptied.has(task.nodeId)) {
      acknowledge(deps, task, 'context_vector_cleared', revision);
    } else {
      deferSurvivorWork(deps.db, task.workId, new Date(deps.now.getTime() + RETRY_DELAY_MS));
      deferred += 1;
    }
  }
  return {
    attempted: tasks.length,
    recomputed: written.size,
    cleared: emptied.size,
    deferred,
  };
}
