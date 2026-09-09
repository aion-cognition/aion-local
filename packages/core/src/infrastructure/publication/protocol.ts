import { PublicationInvariantError } from './errors.js';
import { canonicalJson, decimalSequence } from './json.js';
import { PUBLICATION_PROTOCOL_VERSION, type PublicationCheckpoint } from './types.js';
import type { GuardReceipt } from '../graph/publication-receipt.js';
import type { SqliteHandle } from '../sqlite/database.js';
import {
  acknowledgedRecord,
  assertPendingSlot,
  coordinatorControl,
  publicationRecord,
  publicationResult,
  type CoordinatorControl,
  type PublicationRecord,
} from '../sqlite/publication-coordinator-store.js';

export function matchingReceipt(guard: GuardReceipt, record: PublicationRecord): void {
  if (
    guard.sequence !== record.sequence ||
    guard.operationId !== record.operationId ||
    guard.intentDigest !== record.payloadDigest ||
    guard.resultDigest !== record.resultDigest
  ) {
    throw new PublicationInvariantError('publication_receipt_conflict', record.operationId);
  }
  publicationResult(record);
}

type VerifiedPublicationState = {
  control: CoordinatorControl;
  pending: PublicationRecord | undefined;
  committed: boolean;
};

/**
 * An acknowledgment can finish after releasing the graph lock. Read its control, intent and
 * receipt from one SQLite snapshot so a valid transition cannot appear to violate the protocol.
 * The transaction is synchronous and read-only; it holds no SQLite write lock across graph work.
 */
export function verifyPublicationState(
  db: SqliteHandle,
  guard: GuardReceipt,
): VerifiedPublicationState {
  return db.transaction(() => verifySnapshot(db, guard)).deferred();
}

function verifySnapshot(db: SqliteHandle, guard: GuardReceipt): VerifiedPublicationState {
  const control = coordinatorControl(db);
  if (
    control.bootstrapState !== 'initialized' ||
    control.protocolVersion !== PUBLICATION_PROTOCOL_VERSION ||
    guard.protocolVersion !== PUBLICATION_PROTOCOL_VERSION ||
    guard.substrateId !== control.substrateId
  ) {
    throw new PublicationInvariantError('publication_pairing_or_protocol_mismatch');
  }
  assertPendingSlot(db, control);
  const pending =
    control.pendingOperationId === null
      ? undefined
      : publicationRecord(db, control.pendingOperationId);
  if (
    pending !== undefined &&
    decimalSequence(pending.sequence) <= decimalSequence(control.lastAckSequence)
  ) {
    throw new PublicationInvariantError('publication_pending_order', pending.operationId);
  }
  if (guard.sequence === pending?.sequence) {
    matchingReceipt(guard, pending);
    return { control, pending, committed: true };
  }
  if (guard.sequence !== control.lastAckSequence) {
    throw new PublicationInvariantError(
      'publication_pair_out_of_sync',
      control.pendingOperationId ?? undefined,
    );
  }
  if (guard.sequence === '0') {
    if (
      guard.operationId !== null ||
      guard.intentDigest !== null ||
      guard.resultDigest !== null ||
      control.lastKnownFrom !== null
    ) {
      throw new PublicationInvariantError('publication_initial_receipt_invalid');
    }
  } else {
    const prior = acknowledgedRecord(db, guard.sequence);
    if (prior?.knownFrom !== control.lastKnownFrom) {
      throw new PublicationInvariantError('publication_acknowledgment_missing');
    }
    matchingReceipt(guard, prior);
  }
  return { control, pending, committed: false };
}

export function checkpointFrom(guard: GuardReceipt): PublicationCheckpoint {
  return { ...guard, protocolVersion: PUBLICATION_PROTOCOL_VERSION };
}

export function sameCheckpoint(a: PublicationCheckpoint, b: PublicationCheckpoint): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
