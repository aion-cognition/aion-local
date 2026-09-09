import type { CoverageRefusal } from '@aion/protocol';

import {
  coverageRefusal,
  readCoverageFence,
  readCoverageStanding,
  type CheckedRead,
} from './coverage-checker.js';
import { PublicationInvariantError } from '../../infrastructure/publication/errors.js';
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

export type ReadCompletionDeps = {
  readonly coordinator: ReadCoordinator;
  /**
   * The store the coordinator commits through. The boundary reads the coverage record here when
   * the coordinator declines before the fence can run, which is the only way it can tell an
   * ordinary publication from the activation that changed the contract.
   */
  readonly db: SqliteHandle;
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
   *
   * It must finish before it returns. A `void` slot cannot say that in the type, because
   * TypeScript accepts any returned value where nothing is expected, so the boundary checks it.
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
  /**
   * The publication boundary would not take the effects, under a coverage contract that is
   * readable and unchanged. Nothing persisted, and the position can be taken again. It is not a
   * statement that the answer computed a moment ago is still the right one.
   */
  | { readonly status: 'retry'; readonly reason: string };

type Fenced<T> =
  | { readonly fence: 'matched'; readonly value: T }
  | { readonly fence: 'changed'; readonly epoch: string }
  | { readonly fence: 'unreadable' };

type Verdict<T> =
  | { readonly kind: 'completed'; readonly value: T }
  | { readonly kind: 'changed'; readonly epoch: string }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'retry'; readonly reason: string };

function alwaysValid(): Promise<boolean> {
  return Promise.resolve(true);
}

/**
 * A callback that returns a promise has not finished when the transaction commits, so its
 * writes would land under a fence nobody checked, or not land at all. Throwing here rolls the
 * attempt back. It does not stop the callback's own continuation from running later; nothing
 * in JavaScript can, which is why the contract is that these callbacks are synchronous.
 */
function synchronousEffect(reason: string, value: unknown): void {
  if (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    'then' in value
  ) {
    throw new PublicationInvariantError(reason);
  }
}

/**
 * The one refusal a checked read is answered with, wherever it is decided. An entry point that
 * serves without this boundary — a read whose effects nobody would take — still owes the same
 * answer when the record moved or stopped being readable, and it owes it in the same words.
 */
export function refuseCheckedRead<T>(
  db: SqliteHandle,
  read: CheckedRead,
  reason: 'coverage_changed' | 'coverage_store_unavailable',
): CheckedReadOutcome<T> {
  const { context, coverage } = read;
  const requested = {
    ...(coverage.as_of === undefined ? {} : { asOf: new Date(coverage.as_of) }),
    ...(coverage.knew_at === undefined ? {} : { knewAt: new Date(coverage.knew_at) }),
    now: context.now,
  };
  // Bounds are what is verified now, not what the read was checked against: a caller told a
  // contract changed needs the one that replaced it. A record that cannot be read tells a
  // caller nothing about the substrate's reach, including what it said a moment ago.
  const standing = readCoverageStanding(db);
  if (standing === undefined) {
    return {
      status: 'refused',
      refusal: coverageRefusal('coverage_store_unavailable', requested, {}),
    };
  }
  return {
    status: 'refused',
    refusal: coverageRefusal(reason, requested, {
      coverageState: standing.coverageState,
      ...(standing.historySince === undefined ? {} : { historySince: standing.historySince }),
    }),
  };
}

/**
 * What a declined coordinator settles, read off the record rather than off the decline. Shared
 * by the two ways a position can be missing: never taken, or taken and no longer honoured.
 */
function declined<T>(db: SqliteHandle, read: CheckedRead, reason: string): Verdict<T> {
  const standing = readCoverageStanding(db);
  if (standing === undefined) {
    return { kind: 'unreadable' };
  }
  return standing.epoch === read.context.coverageEpoch
    ? { kind: 'retry', reason }
    : { kind: 'changed', epoch: standing.epoch };
}

/**
 * What a read that could take no position at all settles as, once its work is done.
 *
 * The coordinator declined before this read began, so no fence ever ran, and the same coverage
 * precedence applies: the publication it declined for may be the activation that moved the
 * contract, and an unreadable registry may not hide behind a pending publication. Only a
 * readable, unchanged record leaves it an ordinary publication degradation.
 */
export function withoutPosition<T>(
  db: SqliteHandle,
  read: CheckedRead,
  reason: string,
): CheckedReadOutcome<T> {
  const verdict = declined<T>(db, read, reason);
  if (verdict.kind === 'retry') {
    return { status: 'retry', reason: verdict.reason };
  }
  return refuseCheckedRead(
    db,
    read,
    verdict.kind === 'unreadable' ? 'coverage_store_unavailable' : 'coverage_changed',
  );
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
      synchronousEffect('async_reset_effect', effects.resetDelivery?.(db));
      const value = effects.persist(db);
      synchronousEffect('async_read_effect', value);
      return { fence: 'matched', value };
    },
  );
}

/**
 * What one attempt settled, coverage first.
 *
 * A coordinator that declines before the fence runs has not said anything about coverage, and
 * the publication it declined for may be the activation that changed the contract. Reading the
 * record here is what keeps a real coordinated activation from arriving as an ordinary
 * publication retry, and an unreadable registry from hiding behind one.
 */
function verdictFor<T>(
  db: SqliteHandle,
  effects: CheckedReadEffects<T>,
  attempted: ReadCompletion<Fenced<T>>,
): Verdict<T> {
  if (attempted.status === 'completed') {
    const fenced = attempted.value;
    if (fenced.fence === 'matched') {
      return { kind: 'completed', value: fenced.value };
    }
    return fenced.fence === 'changed'
      ? { kind: 'changed', epoch: fenced.epoch }
      : { kind: 'unreadable' };
  }
  return declined(db, effects.read, attempted.reason);
}

/**
 * The single boundary a checked read commits at.
 *
 * Everything a successful read writes goes through here, so there is one place that decides
 * whether the contract the answer was computed under is still the contract in force. That
 * decision comes first, on every path: a publication that moved the read's position may be the
 * activation that moved the contract, and reporting it as ordinary publication degradation
 * would drop the refusal a caller is owed. A change gets one bounded revalidation, which has to
 * rebuild whatever depended on the old contract; a result that cannot be rebuilt is refused
 * rather than quietly served under the new epoch. Work already spent stays spent, and a refusal
 * here never claims otherwise.
 */
export async function completeCheckedRead<T>(
  deps: ReadCompletionDeps,
  effects: CheckedReadEffects<T>,
  revalidate?: (change: CoverageChange) => Promise<ReadRevalidation<T>>,
): Promise<CheckedReadOutcome<T>> {
  let current = effects;
  // At most two passes: the read as computed, then one rebuilt against the contract in force.
  for (let pass = 0; pass < 2; pass += 1) {
    const verdict = verdictFor(deps.db, current, await attempt(deps.coordinator, current));
    if (verdict.kind === 'completed') {
      return { status: 'completed', value: verdict.value, read: current.read };
    }
    if (verdict.kind === 'unreadable') {
      return refuseCheckedRead(deps.db, current.read, 'coverage_store_unavailable');
    }
    if (verdict.kind === 'retry') {
      return { status: 'retry', reason: verdict.reason };
    }
    if (pass === 1 || revalidate === undefined) {
      break;
    }
    const rebuilt = await revalidate({
      checkedEpoch: current.read.context.coverageEpoch,
      currentEpoch: verdict.epoch,
    });
    if (rebuilt.status === 'abandoned') {
      break;
    }
    current = rebuilt.effects;
  }
  return refuseCheckedRead(deps.db, current.read, 'coverage_changed');
}
