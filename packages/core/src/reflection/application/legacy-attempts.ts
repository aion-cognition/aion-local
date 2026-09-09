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
 * next walk takes an identity of its own rather than waiting on a verdict that already came.
 *
 * An ACKNOWLEDGED attempt whose progress row never moved is a crash between the publication and
 * the record of it. Its receipt is the outcome, and the walk that follows finalizes from it: the
 * work landed, and publishing again would spend a second identity proving what is already proved.
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
    /**
     * Whether this pass is an explicit re-verification. One is a request to prove the member
     * again on evidence somebody repaired, so an older receipt is never its answer: finalizing
     * from one would hand back the verdict the repair was meant to overturn.
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
      if (acknowledged !== undefined && input.status === 'accounted' && !input.reverify) {
        return { operationId: acknowledged.operationId, receipt: receiptOf(acknowledged) };
      }
      return { operationId, payload: input.payload };
    }
    if (record.state === 'prepared') {
      return { operationId, payload: JSON.parse(record.payloadJson) };
    }
    if (record.state === 'acknowledged') {
      acknowledged = record;
    }
  }
  return {
    exhausted: `source ${input.sourceId} exhausted its repair attempts in cohort ${input.cohortId}`,
  };
}
