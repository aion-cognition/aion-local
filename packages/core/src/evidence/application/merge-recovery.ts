import type { Logger } from '../../infrastructure/logging/logger.js';
import {
  PublicationInvariantError,
  type PublicationUnavailable,
  publicationFailure,
} from '../../infrastructure/publication/errors.js';
import type { JsonValue, PublicationOutcome } from '../../infrastructure/publication/types.js';

/**
 * What happens to a batch when one merge cannot be applied.
 *
 * A merge, the scan acknowledgment and the pair acknowledgment happen one after another, so a
 * throw from the write used to take the whole run with it: the pairs already merged lost their
 * tally and the run reported nothing. One failure is one failed pair. The pair keeps its
 * obligation, because nothing was stamped, and the next run tries it again.
 *
 * An uncertain commit is the case that cannot be counted either way. The coordinator holds the
 * receipt that says whether the write landed, so the outcome is reconciled through it before the
 * batch counts a success or moves on. An invariant failure is never one of these: a protocol or
 * pairing violation says the substrate is not in a state to write at all, so it propagates
 * instead of being recorded as an ordinary failed pair.
 */

export type MergeCoordinator = {
  hasPending(): boolean;
  recover(): Promise<PublicationOutcome | undefined>;
  /**
   * What the substrate durably records about one operation. An empty pending slot proves neither
   * rollback nor settlement: another actor may have recovered the same operation first, and the
   * receipt it left is the only thing that says which way it went.
   */
  outcomeOf?(operationId: string): PublicationOutcome | undefined;
};

export type MergeRecoveryInput<T> = {
  /** The pair's stable identity, which is what a receipt is matched against. */
  readonly operationId: string;
  readonly attempt: () => Promise<T>;
  readonly coordinator?: MergeCoordinator;
  readonly logger: Pick<Logger, 'warn'>;
};

export type MergeRecoveryOutcome<T> =
  | { readonly status: 'applied'; readonly value: T }
  /**
   * An earlier attempt's commit, proved by its receipt. It counts once and is not retried. The
   * result the receipt carries travels with it: a receipt says an operation landed, not that a
   * merge did.
   */
  | {
      readonly status: 'settled';
      readonly operationId: string;
      readonly result: JsonValue | undefined;
    }
  /** Nothing landed. The pair keeps its obligation and the batch goes on. */
  | { readonly status: 'failed'; readonly reason: string }
  /** An uncertain publication the coordinator has not settled. The batch stops here. */
  | { readonly status: 'halted'; readonly reason: string };

/** Only a commit whose outcome nobody observed needs the receipt to decide it. */
function uncertainCommit(error: PublicationUnavailable): boolean {
  return error.reason === 'pending_recovery';
}

async function reconcile<T>(
  input: MergeRecoveryInput<T>,
  reason: string,
): Promise<MergeRecoveryOutcome<T>> {
  const { coordinator } = input;
  if (coordinator === undefined) {
    return { status: 'halted', reason: 'uncertain_commit_without_coordinator' };
  }
  let recovered: PublicationOutcome | undefined;
  try {
    recovered = await coordinator.recover();
  } catch (err) {
    // A protocol or pairing violation raised while recovering says the substrate is not in a
    // state to write at all. Recording it as an ordinary halt would bury the invariant.
    if (err instanceof PublicationInvariantError) {
      throw err;
    }
    input.logger.warn({ err, operationId: input.operationId }, 'merge recovery could not settle');
    return { status: 'halted', reason: 'recovery_failed' };
  }
  const settled = durableOutcome(coordinator, recovered, input.operationId);
  if (settled?.status === 'acknowledged') {
    return { status: 'settled', operationId: input.operationId, result: settled.result };
  }
  if (settled !== undefined) {
    return { status: 'failed', reason };
  }
  // An empty pending slot proves neither rollback nor settlement, so a batch that cannot read
  // its own operation's outcome stops rather than counting one it cannot see.
  return coordinator.hasPending()
    ? { status: 'halted', reason: 'publication_still_pending' }
    : { status: 'halted', reason: 'uncertain_commit_unresolved' };
}

/**
 * What the substrate says about this operation: what this recovery pass returned, or, when
 * another actor got there first, the receipt it left behind.
 */
function durableOutcome(
  coordinator: MergeCoordinator,
  recovered: PublicationOutcome | undefined,
  operationId: string,
): PublicationOutcome | undefined {
  if (recovered?.operationId === operationId) {
    return recovered;
  }
  return coordinator.outcomeOf?.(operationId);
}

/**
 * One merge attempt with its failure semantics.
 *
 * A success is a success. A recognized failure is one failed pair with its obligation intact. An
 * uncertain commit goes to the coordinator, and the batch continues only once the coordinator can
 * accept another operation.
 */
export async function applyMergeWithRecovery<T>(
  input: MergeRecoveryInput<T>,
): Promise<MergeRecoveryOutcome<T>> {
  try {
    const value = await input.attempt();
    if (input.coordinator?.hasPending() === true) {
      return { status: 'halted', reason: 'publication_still_pending' };
    }
    return { status: 'applied', value };
  } catch (err) {
    if (err instanceof PublicationInvariantError) {
      throw err;
    }
    const failure = publicationFailure(err, input.operationId);
    if (uncertainCommit(failure)) {
      return reconcile(input, failure.reason);
    }
    input.logger.warn(
      { err, operationId: input.operationId, reason: failure.reason },
      'merge attempt failed and left its pair retryable',
    );
    if (input.coordinator?.hasPending() === true) {
      return { status: 'halted', reason: 'publication_still_pending' };
    }
    return { status: 'failed', reason: failure.reason };
  }
}
