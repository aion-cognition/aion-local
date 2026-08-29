import { countOpenEntityMergeProposals } from '../../infrastructure/sqlite/entity-merge-proposals.js';
import { p95EnrichmentLagMs } from '../../infrastructure/sqlite/lag-samples.js';
import { cueDegradedRate } from '../../infrastructure/sqlite/recall-samples.js';
import { reinforcementQueueDroppedCount } from '../../infrastructure/sqlite/reinforcement-queue.js';
import { countOpenSupersessionProposals } from '../../infrastructure/sqlite/supersession-proposals.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { countQueueJobs, countQueueJobsByLane } from '../../infrastructure/sqlite/reflection-queue-admin.js';
import { REFLECTION_LANES, type ReflectionLane } from '../../infrastructure/sqlite/reflection-queue.js';

/**
 * The operator's read of everything the exercise had no gauge for, in one SQLite pass: `aion
 * doctor` passed 8 of 8 checks with 4,000+ jobs pending because none of this existed. Every
 * field is a SQLite read — no Neo4j, no Ollama — so this is cheap enough for `/health` to
 * compute on every liveness probe.
 */
export type QueueLagSnapshot = {
  /** Claimable rows only. An exhausted row is not depth: no worker will ever take it. */
  readonly depthByLane: Readonly<Record<ReflectionLane, number>>;
  /** `undefined` when nothing is waiting, not zero — there is no age to report. */
  readonly oldestUnclaimedMs: number | undefined;
  /** Unclaimed rows past `workerMaxAttempts`; claiming skips them forever without maintenance. */
  readonly exhausted: number;
  readonly reinforcementDropped: number;
  /** `undefined` until the first job completes; see `lag-samples.ts`. */
  readonly p95EnrichmentLagMs: number | undefined;
  /**
   * Share of recent recalls that answered without the cue model. `undefined` until the first
   * recall lands, so a fresh install reads as unmeasured rather than as healthy.
   */
  readonly cueDegradedRate: number | undefined;
  /**
   * Judged contradictions and duplicate entities waiting on a person. With auto-apply off
   * these tables are the whole review queue, and an uncounted queue is a queue nobody works.
   */
  readonly supersessionProposalsOpen: number;
  readonly entityMergeProposalsOpen: number;
};

export function queueLagSnapshot(
  db: SqliteHandle,
  workerMaxAttempts: number,
  now: Date = new Date(),
): QueueLagSnapshot {
  const counts = countQueueJobs(db, {}, workerMaxAttempts);
  const byLane = countQueueJobsByLane(db, workerMaxAttempts);
  const depthByLane = Object.fromEntries(
    REFLECTION_LANES.map((lane) => [lane, byLane.get(lane) ?? 0]),
  ) as Record<ReflectionLane, number>;

  return {
    depthByLane,
    oldestUnclaimedMs:
      counts.oldestPendingAt === undefined
        ? undefined
        : Math.max(0, now.getTime() - new Date(counts.oldestPendingAt).getTime()),
    exhausted: counts.exhausted,
    reinforcementDropped: reinforcementQueueDroppedCount(db),
    p95EnrichmentLagMs: p95EnrichmentLagMs(db),
    cueDegradedRate: cueDegradedRate(db),
    supersessionProposalsOpen: countOpenSupersessionProposals(db),
    entityMergeProposalsOpen: countOpenEntityMergeProposals(db),
  };
}
