import type { Driver } from 'neo4j-driver';
import type { Config } from '../../infrastructure/config/schema.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import type { OperationBucket } from './buckets.js';
import type { CriticalCondition, HealthSnapshot } from './health.js';

/**
 * The contract every maintenance operation implements. It is deliberately small: a name, the
 * window it may run in, how much this snapshot calls for it, and the work itself. Everything
 * else the loop needs (which instance owns the window, whether the operation earned its next
 * turn, what it did) the engine derives, so an operation never has to reason about scheduling,
 * idempotency, or its own history.
 *
 * Tier is a property of the cycle rather than of the operation. An operation earns tier 1 by
 * naming the critical condition it repairs in `answers`, and it preempts only on the cycles
 * the snapshot meets that condition. Every other cycle the same operation is scored routinely,
 * which is what stops a standing pathology from being a standing preemption.
 */

export type OperationTier = 1 | 2;

export type OperationContext = {
  readonly driver: Driver;
  readonly db: SqliteHandle;
  readonly config: Config;
  readonly logger: Logger;
  /** The same reading the decision was made from. An operation must not observe again. */
  readonly health: HealthSnapshot;
  readonly now: Date;
  /** Aborted when the service is shutting down. An operation that can stop early should. */
  readonly signal: AbortSignal;
};

export type OperationStatus = 'applied' | 'noop' | 'failed';

export type OperationOutcome = {
  readonly status: OperationStatus;
  /** What the operation looked at, which bounds what it could have changed. */
  readonly itemsProcessed: number;
  readonly itemsAffected: number;
  /** One plain line for the ledger summary and the log. No node text, no secrets. */
  readonly detail?: string;
};

export type IntrospectionOperation = {
  readonly name: string;
  /**
   * The tier-1 condition this operation repairs. Declaring one is what makes the operation an
   * emergency responder for that condition and nothing else: it preempts the routine catalog
   * on the cycles the condition holds, and its `relevance` must still return zero when there
   * is no work, since a preemption with nothing to do blocks everything else for free.
   */
  readonly answers?: CriticalCondition;
  readonly bucket: OperationBucket;
  /**
   * How much this snapshot calls for the operation, on 0 to 1. Zero means there is nothing to
   * do and the engine will not select it however long it has waited: starvation protection
   * raises the priority of work that exists, it does not invent work.
   */
  relevance(health: HealthSnapshot): number;
  /**
   * The one number this operation exists to move, read from a snapshot. The engine takes it
   * before the run and again on a later tick, and scores the operation on whether it went the
   * declared direction. Omit it when the operation has no metric in the snapshot; the run is
   * then scored on whether it applied anything.
   */
  measure?(health: HealthSnapshot): number;
  /** Which way `measure` should move. Defaults to `lower` when omitted. */
  readonly improves?: 'lower' | 'higher';
  run(ctx: OperationContext): Promise<OperationOutcome>;
};

export function operationImprovement(operation: IntrospectionOperation): 'lower' | 'higher' {
  return operation.improves ?? 'lower';
}

export function measureImproved(
  operation: IntrospectionOperation,
  before: number,
  after: number,
): boolean {
  if (operationImprovement(operation) === 'higher') {
    return after > before;
  }
  return after < before;
}
