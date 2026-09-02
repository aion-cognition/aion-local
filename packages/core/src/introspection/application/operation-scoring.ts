import type { Logger } from '../../infrastructure/logging/logger.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  clearPendingMeasure,
  operationStats,
  recordOperationDuration,
  recordOperationResolution,
  setPendingMeasure,
  type OperationResolution,
} from '../../infrastructure/sqlite/introspection-counters.js';
import type { HealthSnapshot } from '../domain/health.js';
import {
  measureImproved,
  type IntrospectionOperation,
  type OperationOutcome,
} from '../domain/operation.js';

/**
 * Scoring a maintenance run against the metric it declared, and recording what the run cost.
 *
 * One rule runs through all of it: a run is scored only where a declared metric can contradict
 * it. An operation that names a number in the snapshot parks its pre-run reading and is judged
 * on the next cycle by whether that number went the declared way. An operation that names none
 * is recorded as having run and nothing more, because the only verdict available without a
 * metric is the operation's own report of what it did, and a loop that weights operations on
 * that is measuring willingness rather than effect.
 */

export type ScoringDeps = {
  readonly db: SqliteHandle;
  readonly logger: Logger;
};

export type ResolvedRun = {
  readonly name: string;
  readonly resolution: OperationResolution;
};

/** A metric that throws is an unscored run, not a dead loop. */
export function readMeasure(
  deps: ScoringDeps,
  operation: IntrospectionOperation,
  health: HealthSnapshot,
): number | undefined {
  if (operation.measure === undefined) {
    return undefined;
  }
  try {
    return operation.measure(health);
  } catch (err) {
    deps.logger.warn({ err, operation: operation.name }, 'operation measure failed');
    return undefined;
  }
}

/**
 * Scores every run that was waiting on a later reading. The reading was taken before the run
 * and is compared against this cycle's snapshot, which is the first one that can see what the
 * run did after the rest of the system settled around it.
 *
 * A partial snapshot scores nothing. A collector that fell back reports its metric at a
 * neutral value, which an operation trying to drive that metric down would read as a
 * spectacular success; the pending reading stays put instead and waits for a whole one.
 */
export function resolvePendingMeasures(
  deps: ScoringDeps,
  operations: readonly IntrospectionOperation[],
  health: HealthSnapshot,
): readonly ResolvedRun[] {
  const resolved: ResolvedRun[] = [];
  if (health.degraded.length > 0) {
    return resolved;
  }
  for (const operation of operations) {
    if (operation.measure === undefined) {
      continue;
    }
    const stats = operationStats(deps.db, operation.name);
    if (stats.pendingMeasure === undefined) {
      continue;
    }
    const after = readMeasure(deps, operation, health);
    if (after === undefined) {
      continue;
    }
    const resolution: OperationResolution = measureImproved(operation, stats.pendingMeasure, after)
      ? 'improved'
      : 'unchanged';
    recordOperationResolution(deps.db, operation.name, resolution);
    clearPendingMeasure(deps.db, operation.name);
    resolved.push({ name: operation.name, resolution });
  }
  return resolved;
}

/**
 * What one finished run leaves behind. The cost lands whatever the run did, since a failure
 * that took a minute cost the tick a minute. An operation with a metric parks its pre-run
 * reading and is scored on the next cycle; one without is recorded as unmeasured, which counts
 * as a run and answers nothing about whether it helped. A failure resolves immediately either
 * way, since there is nothing to measure and waiting a cycle would only delay the
 * deprioritization.
 */
export function recordRunOutcome(
  deps: ScoringDeps,
  operation: IntrospectionOperation,
  outcome: OperationOutcome,
  before: number | undefined,
  durationMs: number,
): void {
  recordOperationDuration(deps.db, operation.name, durationMs);
  if (outcome.status === 'failed') {
    clearPendingMeasure(deps.db, operation.name);
    recordOperationResolution(deps.db, operation.name, 'failed');
    return;
  }
  if (before !== undefined) {
    setPendingMeasure(deps.db, operation.name, before);
    return;
  }
  recordOperationResolution(deps.db, operation.name, 'unmeasured');
}
