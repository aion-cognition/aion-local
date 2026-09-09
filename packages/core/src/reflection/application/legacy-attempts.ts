import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import type { MigrationStatus } from '../../infrastructure/sqlite/migration-cohorts.js';
import {
  publicationRecord,
  type PublicationRecord,
} from '../../infrastructure/sqlite/publication-coordinator-store.js';

/**
 * Which walk of one member comes next, decided from what its earlier walks durably left behind.
 *
 * A member is walked under an identity, and the identity is what makes a retry safe: the same one
 * resumes, a new one is a new attempt on different proof. Three records mean three different
 * things, and reading them as one is how work is either lost or done twice.
 *
 * An UNFINISHED attempt is resumed with the request it saved, never with the caller's newer one:
 * the identity check exists to refuse a second payload under a first payload's name, and rebuilding
 * the request from today's arguments is exactly that write.
 *
 * A DEFERRED or REJECTED attempt is terminal for its identity. Nothing will ever finish it, so the
 * next walk takes an identity of its own rather than waiting on a verdict that already came — and
 * it also SUPERSEDES any older acknowledgment: a receipt from before a verdict that has since come
 * and gone is not the outcome of the work being asked for now.
 *
 * An ACKNOWLEDGED attempt this member's row has not accounted for is a crash between the
 * publication and the record of it. Its receipt is the outcome, and the walk that follows finalizes
 * from it: the work landed, and publishing again would spend a second identity proving what is
 * already proved. Which attempt the row accounts for is the durable association `walked_by` holds,
 * and it is the only thing that separates recovering a lost reply from asking for a new
 * verification — through the caller's arguments the two are identical.
 */

/** A member nobody can repair in this many walks needs a person, not another identity. */
export const MAX_REPAIR_ATTEMPTS = 64;

/** What an acknowledged walk concluded, as the progress row records it. */
export type AttemptReceipt = {
  readonly pinned: boolean;
  readonly verified: boolean;
  readonly reason: string;
};

export type MemberAttempt = {
  /** The identity to publish under. Absent only when the member is out of identities. */
  readonly operationId?: string;
  /** The request to publish: the saved one when an unfinished attempt is being resumed. */
  readonly payload?: unknown;
  /** An acknowledged receipt to finalize progress from instead of walking again. */
  readonly receipt?: AttemptReceipt;
  /** Why no walk is possible. The caller records a durable pin rather than throwing the batch away. */
  readonly exhausted?: string;
};

/**
 * Whether this member's row already accounts for that attempt.
 *
 * The recorded association answers it outright. A row written before the association existed has
 * no answer of its own, and then its status stands in: a member still waiting to be walked has
 * accounted for nothing, and one carrying a verdict has accounted for whatever produced it.
 */
function accountedFor(
  input: { readonly walkedBy?: string | undefined; readonly status: MigrationStatus | undefined },
  operationId: string,
): boolean {
  return input.walkedBy === undefined
    ? input.status !== undefined && input.status !== 'accounted'
    : input.walkedBy === operationId;
}

function receiptOf(record: PublicationRecord): AttemptReceipt {
  const result = JSON.parse(record.resultJson ?? '{}') as {
    pinned?: boolean;
    verified?: boolean;
    reason?: string;
  };
  return {
    pinned: result.pinned === true,
    verified: result.verified === true,
    reason: result.reason ?? 'the producer recorded no reason',
  };
}

export function planMemberAttempt(
  db: SqliteHandle,
  input: {
    readonly cohortId: string;
    readonly sourceId: string;
    readonly payload: unknown;
    /** What the cohort currently records about the member, or nothing where it records none. */
    readonly status: MigrationStatus | undefined;
    /** The walk that status came from, where the row records one. */
    readonly walkedBy?: string | undefined;
    /**
     * Whether the caller is asking for an explicit re-verification. It travels in the request and
     * is deliberately NOT read here: a retry of a lost reply and a genuinely new verification look
     * identical through this boolean, and inferring the difference from it is what spends a third
     * identity on work a second one already did. The durable association decides instead.
     */
    readonly reverify: boolean;
  },
): MemberAttempt {
  const base = `legacy-materialization:${input.cohortId}:${input.sourceId}`;
  let acknowledged: PublicationRecord | undefined;
  for (let attempt = 1; attempt <= MAX_REPAIR_ATTEMPTS; attempt += 1) {
    const operationId = attempt === 1 ? base : `${base}#${String(attempt)}`;
    const record = publicationRecord(db, operationId);
    if (record === undefined) {
      if (acknowledged !== undefined && !accountedFor(input, acknowledged.operationId)) {
        return { operationId: acknowledged.operationId, receipt: receiptOf(acknowledged) };
      }
      return { operationId, payload: input.payload };
    }
    if (record.state === 'prepared') {
      return { operationId, payload: JSON.parse(record.payloadJson) };
    }
    // A verdict that has already come and gone supersedes anything before it.
    acknowledged = record.state === 'acknowledged' ? record : undefined;
  }
  return {
    exhausted: `source ${input.sourceId} exhausted its repair attempts in cohort ${input.cohortId}`,
  };
}
