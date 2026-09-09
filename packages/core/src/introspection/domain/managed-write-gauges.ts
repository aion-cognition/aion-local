import { measuredGauge, type Gauge, type GaugeBasis, type GaugeStamp } from './campaign-gauges.js';
import type { ManagedWriteObservations } from '../../infrastructure/graph/managed-write-observations.js';

/**
 * The managed-retry counts, reported in the envelope every other campaign observation is
 * reported in, so a replay count carries the population it was counted over the way a stale
 * edge count does.
 *
 * The readings are process-local by construction: they come from a counter one driver
 * accumulates in memory, so only a reader inside the process that ran the writes can measure
 * them. A collector that runs somewhere else owes these observations a `not_collected`, which
 * is what the group table gives it, because a partial collector reporting zero would read as
 * a substrate that never replays a transaction.
 */

/** Bumped when a name here changes what it counts, so a delta refuses to subtract across it. */
export const MANAGED_WRITE_METRIC_VERSION = 1;

/**
 * What the counts are taken over. Carried on every reading because the population is the part
 * a reader gets wrong: these are one driver's callback invocations in one process, and the
 * write paths with no callback are not in them at all.
 */
const MANAGED_WRITE_DENOMINATOR =
  'write transaction callbacks one driver ran through inWriteTransaction in this process. ' +
  'A begin or commit failure is counted as a replay with its cause unknown, the executeQuery ' +
  'write helpers retry with no callback to count, and the explicit publication transaction ' +
  'takes no managed retry.';

/**
 * Every observation this reading owes, in the order the gauges come back. Declared here and
 * spread into the group table, so the names a reader looks for and the names a run reports
 * cannot drift apart.
 */
export const MANAGED_WRITE_OBSERVATIONS = [
  'managed_write_logical_operations',
  'managed_write_callback_attempts',
  'managed_write_callback_replays',
  'managed_write_callback_replays_deadlock',
  'managed_write_callback_replays_other_transient',
  'managed_write_callback_replays_outside_callback',
  'managed_write_callback_failures',
  'managed_write_caller_fulfilments',
  'managed_write_caller_rejections',
  'managed_write_observer_failures',
] as const;

/**
 * The epoch rides in `cohortId` so two samples taken from different drivers or different
 * processes report a changed basis rather than a difference. Cumulative counters restart at
 * zero with the process, and a delta across that boundary is a negative number nobody can
 * read.
 */
function managedWriteBasis(observations: ManagedWriteObservations): GaugeBasis {
  return {
    population: 'live',
    denominator: MANAGED_WRITE_DENOMINATOR,
    cohortId: observations.epoch,
  };
}

/**
 * The counts as gauges. Every one is measured, zero included: a driver that ran writes and
 * replayed none of them is a different fact from a driver nobody watched, and the group table
 * reports the second as unavailable.
 */
export function managedWriteGauges(
  observations: ManagedWriteObservations,
  sampledAt: string,
): ReadonlyMap<string, Gauge> {
  const stamp: GaugeStamp = {
    sampledAt,
    basis: managedWriteBasis(observations),
    metricVersion: MANAGED_WRITE_METRIC_VERSION,
  };
  const calls = (value: number): Gauge => measuredGauge(value, 'calls', stamp);
  const invocations = (value: number): Gauge => measuredGauge(value, 'invocations', stamp);
  return new Map<string, Gauge>([
    ['managed_write_logical_operations', calls(observations.logicalOperations)],
    ['managed_write_callback_attempts', invocations(observations.callbackAttempts)],
    ['managed_write_callback_replays', invocations(observations.callbackReplays)],
    ['managed_write_callback_replays_deadlock', invocations(observations.replaysByClass.deadlock)],
    [
      'managed_write_callback_replays_other_transient',
      invocations(observations.replaysByClass.other_transient),
    ],
    [
      'managed_write_callback_replays_outside_callback',
      invocations(observations.replaysByClass.outside_callback),
    ],
    ['managed_write_callback_failures', invocations(observations.callbackFailures)],
    ['managed_write_caller_fulfilments', calls(observations.callerFulfilments)],
    ['managed_write_caller_rejections', calls(observations.callerRejections)],
    [
      'managed_write_observer_failures',
      measuredGauge(observations.observerFailures, 'faults', stamp),
    ],
  ]);
}
