import type { CoverageRefusal } from '@aion/protocol';

import { coverageRefusal, readCoverageFence, type CheckedRead } from './coverage-checker.js';
import type {
  ReadCompletion,
  SynchronousResult,
} from '../../infrastructure/publication/read-barrier.js';
import type {
  CheckpointResult,
  PublicationCheckpoint,
  PublicationContext,
} from '../../infrastructure/publication/types.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';

/**
 * The coordinator surface a checked read needs: a position to hold while it works, and a
 * boundary to commit its effects at.
 */
export type ReadCoordinator = {
  checkpoint(): Promise<CheckpointResult>;
  completeRead<T>(
    checkpoint: PublicationCheckpoint,
    validate: (context: PublicationContext) => Promise<boolean>,
    complete: (db: SqliteHandle) => SynchronousResult<T>,
  ): Promise<ReadCompletion<T>>;
};

export type CheckedReadEffects<T> = {
  readonly read: CheckedRead;
  /** The position taken before the work started. */
  readonly checkpoint: PublicationCheckpoint;
  /** Graph reads only. The guard transaction always rolls back, success included. */
  readonly validate?: (context: PublicationContext) => Promise<boolean>;
  /**
   * Deletes what this session was already served, when the caller asked to forget it.
   *
   * The deletion is staged rather than done when the request arrives: the run computes against
   * an empty served set in memory, and the durable rows go only here, inside the same
   * transaction as the fence. Deleting early would let a read that then refuses take the
   * caller's holdings with it.
   */
  readonly resetDelivery?: (db: SqliteHandle) => void;
  /** Every other successful-read effect, all synchronous: the served pack, the counters. */
  readonly persist: (db: SqliteHandle) => SynchronousResult<T>;
};

export type CoverageChange = {
  readonly checkedEpoch: string;
  readonly currentEpoch: string;
};

/**
 * What one bounded revalidation produced. `reconstructed` carries a result rebuilt against the
 * contract now in force; there is no third answer that keeps the old artifact and stamps it
 * with the new epoch.
 */
export type ReadRevalidation<T> =
  | { readonly status: 'reconstructed'; readonly effects: CheckedReadEffects<T> }
  | { readonly status: 'abandoned' };

export type CheckedReadOutcome<T> =
  | { readonly status: 'completed'; readonly value: T; readonly read: CheckedRead }
  | { readonly status: 'refused'; readonly refusal: CoverageRefusal }
  /** The answer stands; its effects did not persist and the caller may take the position again. */
  | { readonly status: 'retry'; readonly reason: string };

type Fenced<T> =
  | { readonly fence: 'matched'; readonly value: T }
  | { readonly fence: 'changed'; readonly epoch: string }
  | { readonly fence: 'unreadable' };

function alwaysValid(): Promise<boolean> {
  return Promise.resolve(true);
}

function refuse<T>(
  read: CheckedRead,
  reason: 'coverage_changed' | 'coverage_store_unavailable',
): CheckedReadOutcome<T> {
  const { context, coverage } = read;
  const requested = {
    ...(coverage.as_of === undefined ? {} : { asOf: new Date(coverage.as_of) }),
    ...(coverage.knew_at === undefined ? {} : { knewAt: new Date(coverage.knew_at) }),
    now: context.now,
  };
  // Bounds are what is known now. A record that cannot be read tells a caller nothing about
  // the substrate's reach, including what it said a moment ago.
  const bounds =
    reason === 'coverage_changed'
      ? {
          coverageState: context.coverageState,
          ...(context.coverageState === 'active' ? { historySince: context.historySince } : {}),
        }
      : {};
  return { status: 'refused', refusal: coverageRefusal(reason, requested, bounds) };
}

/**
 * The fence and the effects in one transaction, on purpose. Reading the epoch first and
 * writing afterwards leaves a gap a coverage change can land in, and effects committed in that
 * gap describe a contract the substrate no longer holds.
 */
async function attempt<T>(
  coordinator: ReadCoordinator,
  effects: CheckedReadEffects<T>,
): Promise<ReadCompletion<Fenced<T>>> {
  return coordinator.completeRead<Fenced<T>>(
    effects.checkpoint,
    effects.validate ?? alwaysValid,
    (db): SynchronousResult<Fenced<T>> => {
      const epoch = readCoverageFence(db);
      if (epoch === undefined) {
        return { fence: 'unreadable' };
      }
      if (epoch !== effects.read.context.coverageEpoch) {
        return { fence: 'changed', epoch };
      }
      effects.resetDelivery?.(db);
      return { fence: 'matched', value: effects.persist(db) };
    },
  );
}

/**
 * The single boundary a checked read commits at.
 *
 * Everything a successful read writes goes through here, so there is one place that decides
 * whether the contract the answer was computed under is still the contract in force. A change
 * gets one bounded revalidation, which has to rebuild whatever depended on the old contract;
 * a read that cannot be rebuilt is refused rather than quietly served under the new epoch.
 * Work already spent before a change stays spent, and a refusal at this boundary never claims
 * otherwise.
 */
export async function completeCheckedRead<T>(
  coordinator: ReadCoordinator,
  effects: CheckedReadEffects<T>,
  revalidate?: (change: CoverageChange) => Promise<ReadRevalidation<T>>,
): Promise<CheckedReadOutcome<T>> {
  const first = await attempt(coordinator, effects);
  if (first.status === 'retry') {
    return { status: 'retry', reason: first.reason };
  }
  if (first.value.fence === 'matched') {
    return { status: 'completed', value: first.value.value, read: effects.read };
  }
  if (first.value.fence === 'unreadable') {
    return refuse(effects.read, 'coverage_store_unavailable');
  }
  const rebuilt =
    revalidate === undefined
      ? ({ status: 'abandoned' } as const)
      : await revalidate({
          checkedEpoch: effects.read.context.coverageEpoch,
          currentEpoch: first.value.epoch,
        });
  if (rebuilt.status === 'abandoned') {
    return refuse(effects.read, 'coverage_changed');
  }
  const second = await attempt(coordinator, rebuilt.effects);
  if (second.status === 'retry') {
    return { status: 'retry', reason: second.reason };
  }
  if (second.value.fence === 'matched') {
    return { status: 'completed', value: second.value.value, read: rebuilt.effects.read };
  }
  return refuse(
    rebuilt.effects.read,
    second.value.fence === 'unreadable' ? 'coverage_store_unavailable' : 'coverage_changed',
  );
}
