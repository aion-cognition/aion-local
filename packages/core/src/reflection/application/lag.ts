import { INTAKE_JOB_TYPE, SOURCE_INDEX_JOB_TYPE } from './intake-queue.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { countOpenEntityMergeProposals } from '../../infrastructure/sqlite/entity-merge-proposals.js';
import { p95EnrichmentLagMs } from '../../infrastructure/sqlite/lag-samples.js';
import { cueDegradedRate } from '../../infrastructure/sqlite/recall-samples.js';
import {
  countQueueJobs,
  countQueueJobsByLane,
} from '../../infrastructure/sqlite/reflection-queue-admin.js';
import {
  REFLECTION_LANES,
  type ReflectionLane,
} from '../../infrastructure/sqlite/reflection-queue.js';
import { reinforcementQueueDroppedCount } from '../../infrastructure/sqlite/reinforcement-queue.js';
import { countOpenSupersessionProposals } from '../../infrastructure/sqlite/supersession-proposals.js';

/**
 * The operator's read of everything that had no gauge, in one SQLite pass: `aion doctor`
 * passed 8 of 8 checks with 4,000+ jobs pending because none of this existed. Every field is
 * a SQLite read, no Neo4j and no Ollama, so this is cheap enough for `/health` to compute on
 * every liveness probe.
 */
export type QueueLagSnapshot = {
  /**
   * Claimable `integrate` rows only. An exhausted row is not depth: no worker will ever take it,
   * and neither is a `source_index` row, which the reflection worker's claim filter excludes.
   * Folding the index rows in here reported one number that was secretly two populations, and
   * the depth gauge tripped at half the real reflection backlog.
   */
  readonly depthByLane: Readonly<Record<ReflectionLane, number>>;
  /** `undefined` when nothing is waiting, not zero: there is no age to report. */
  readonly oldestUnclaimedMs: number | undefined;
  /**
   * Unclaimed `integrate` rows past `workerMaxAttempts`; claiming skips them forever without
   * maintenance. An index row that exhausts its own attempts is not one of these.
   */
  readonly exhausted: number;
  /**
   * Claimable `source_index` rows, counted beside the reflection backlog rather than inside it.
   * An operator needs both numbers: these never move under the reflection worker, and every
   * source behind them stays eviction-pinned until their own handler drains them.
   */
  readonly indexDepth: number;
  readonly reinforcementDropped: number;
  /** `undefined` until the first job completes; see `lag-samples.ts`. */
  readonly p95EnrichmentLagMs: number | undefined;
  /**
   * Share of recent recalls that degraded on the recall model call: the assessment, or cue
   * extraction under `AION_RECALL_MODE=cues`. `undefined` until the first recall lands, so a
   * fresh install reads as unmeasured rather than as healthy.
   */
  readonly cueDegradedRate: number | undefined;
  /**
   * Judged contradictions and duplicate entities still open. `proposal_resolution` decides them
   * on its own; the count is how a backlog it has not reached yet stays visible.
   */
  readonly supersessionProposalsOpen: number;
  readonly entityMergeProposalsOpen: number;
};

export function queueLagSnapshot(
  db: SqliteHandle,
  workerMaxAttempts: number,
  now: Date = new Date(),
): QueueLagSnapshot {
  const counts = countQueueJobs(db, { jobType: INTAKE_JOB_TYPE }, workerMaxAttempts);
  const byLane = countQueueJobsByLane(db, { jobType: INTAKE_JOB_TYPE }, workerMaxAttempts);
  const index = countQueueJobs(db, { jobType: SOURCE_INDEX_JOB_TYPE }, workerMaxAttempts);
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
    indexDepth: index.pending,
    reinforcementDropped: reinforcementQueueDroppedCount(db),
    p95EnrichmentLagMs: p95EnrichmentLagMs(db),
    cueDegradedRate: cueDegradedRate(db),
    supersessionProposalsOpen: countOpenSupersessionProposals(db),
    entityMergeProposalsOpen: countOpenEntityMergeProposals(db),
  };
}
