import { p95EnrichmentLagMs } from '../../infrastructure/sqlite/lag-samples.js';
import { reinforcementQueueDroppedCount } from '../../infrastructure/sqlite/reinforcement-queue.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { countQueueJobs, countQueueJobsByLane } from '../../infrastructure/sqlite/reflection-queue-admin.js';
import { REFLECTION_LANES, type ReflectionLane } from '../../infrastructure/sqlite/reflection-queue.js';

/**
 * The blind spots `aion doctor` could not see: it passed 8 of 8 checks with 4,000+ jobs
 * pending because nothing here existed. Every field is a SQLite read, no Neo4j and no Ollama,
 * so this is cheap enough for `/health` to compute on every liveness probe.
 */
export type QueueLagSnapshot = {
  readonly depthByLane: Readonly<Record<ReflectionLane, number>>;
  /** `undefined` when nothing is unclaimed, not zero: there is no age to report. */
  readonly oldestUnclaimedMs: number | undefined;
  /** Unclaimed rows past `workerMaxAttempts`; claiming skips them forever without maintenance. */
  readonly exhausted: number;
  readonly reinforcementDropped: number;
  /** `undefined` until the first job completes; see `lag-samples.ts`. */
  readonly p95EnrichmentLagMs: number | undefined;
};

export function queueLagSnapshot(
  db: SqliteHandle,
  workerMaxAttempts: number,
  now: Date = new Date(),
): QueueLagSnapshot {
  const counts = countQueueJobs(db, {}, workerMaxAttempts);
  const byLane = countQueueJobsByLane(db);
  const depthByLane = Object.fromEntries(
    REFLECTION_LANES.map((lane) => [lane, byLane.get(lane) ?? 0]),
  ) as Record<ReflectionLane, number>;

  return {
    depthByLane,
    oldestUnclaimedMs:
      counts.oldestUnclaimedAt === undefined
        ? undefined
        : Math.max(0, now.getTime() - new Date(counts.oldestUnclaimedAt).getTime()),
    exhausted: counts.exhausted,
    reinforcementDropped: reinforcementQueueDroppedCount(db),
    p95EnrichmentLagMs: p95EnrichmentLagMs(db),
  };
}
