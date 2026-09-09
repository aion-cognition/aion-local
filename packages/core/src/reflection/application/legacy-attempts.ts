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
 *
 * A row from before that association was recorded has no such answer, and a status is not one: an
 * old verdict and an accounting for a newer publication whose reply was lost are the same label.
 * Such a row is bound to its walk first, and only where a single outstanding acknowledgment
 * reports exactly the verdict and reason the row holds; anything else is recovered instead, so no
 * further identity is spent while an unaccounted receipt is on the books.
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
  /**
   * The walk a row predating the association is to be bound to, recorded BEFORE the new
   * publication goes out. Without that write first, the reply this attempt is waiting for and the
   * verdict the row already carries are the same unanswerable question on the next pass.
   */
  readonly associate?: string;
  /** Why no walk is possible. The caller records a durable pin rather than throwing the batch away. */
  readonly exhausted?: string;
};

/**
 * The status a walk records from its receipt.
 *
 * The producer's two gates are different failures: a source with no proof at all and a proved one
 * whose relationships cannot be represented both pin, and only a source that cleared both
 * verifies. The batch records from this, so a receipt read back later derives the same verdict.
 */
export function receiptStatus(receipt: {
  readonly pinned: boolean;
  readonly verified: boolean;
}): MigrationStatus {
  return receipt.verified && !receipt.pinned ? 'verified' : 'pinned';
}

/** What the member's row currently says, and which walk it says it. */
type MemberRow = {
  readonly walkedBy?: string | undefined;
  readonly status?: MigrationStatus | undefined;
  readonly reason?: string | undefined;
};

/**
 * Whether the row's own verdict was recorded from this receipt.
 *
 * A status alone proves nothing — every walk of a pinned member reports `pinned` — so the reason
 * the producer gave is checked with it. That is the whole of what the row durably holds about its
 * walk, and a receipt that does not answer for both is not the one the row came from.
 */
function reports(receipt: AttemptReceipt, row: MemberRow): boolean {
  return (
    row.status !== undefined &&
    receiptStatus(receipt) === row.status &&
    receipt.reason === row.reason
  );
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

/**
 * The walk that follows the acknowledgments nothing has superseded.
 *
 * With an association recorded, the row answers for itself. Without one the row predates the
 * association and answers nothing on its own, so exactly one outstanding acknowledgment that
 * reports the verdict the row carries is that row's walk: it is bound to the row first, and the
 * new attempt goes out under an identity of its own. Every other shape leaves at least one
 * acknowledgment nobody has accounted for, and that receipt is recovered rather than published
 * over — a second walk cannot prove what the first one already proved, only spend an identity
 * looking as though it might have.
 */
function walkAfter(
  input: MemberRow & { readonly payload: unknown },
  next: { readonly operationId: string; readonly outstanding: readonly PublicationRecord[] },
): MemberAttempt {
  const latest = next.outstanding.at(-1);
  if (latest === undefined) {
    return { operationId: next.operationId, payload: input.payload };
  }
  if (input.walkedBy !== undefined) {
    return input.walkedBy === latest.operationId
      ? { operationId: next.operationId, payload: input.payload }
      : { operationId: latest.operationId, receipt: receiptOf(latest) };
  }
  const single = next.outstanding.length === 1 ? latest : undefined;
  return single !== undefined && reports(receiptOf(single), input)
    ? { associate: single.operationId, operationId: next.operationId, payload: input.payload }
    : { operationId: latest.operationId, receipt: receiptOf(latest) };
}

export function planMemberAttempt(
  db: SqliteHandle,
  input: {
    readonly cohortId: string;
    readonly sourceId: string;
    readonly payload: unknown;
    /**
     * What the cohort currently records about the member. It is never read as an accounting: a
     * verdict names no operation, and treating one as an attempt identity is how a lost reply
     * becomes a third publication. It is read only to recognise which acknowledgment a row
     * predating the association was written from.
     */
    readonly status?: MigrationStatus | undefined;
    /** The reason recorded with that status, which is the rest of what the row holds about it. */
    readonly reason?: string | undefined;
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
  /** The acknowledged walks, in identity order, that no later verdict has superseded. */
  let outstanding: readonly PublicationRecord[] = [];
  for (let attempt = 1; attempt <= MAX_REPAIR_ATTEMPTS; attempt += 1) {
    const operationId = attempt === 1 ? base : `${base}#${String(attempt)}`;
    const record = publicationRecord(db, operationId);
    if (record === undefined) {
      return walkAfter(input, { operationId, outstanding });
    }
    if (record.state === 'prepared') {
      return { operationId, payload: JSON.parse(record.payloadJson) };
    }
    // A verdict that has already come and gone supersedes anything before it.
    outstanding = record.state === 'acknowledged' ? [...outstanding, record] : [];
  }
  return {
    exhausted: `source ${input.sourceId} exhausted its repair attempts in cohort ${input.cohortId}`,
  };
}
