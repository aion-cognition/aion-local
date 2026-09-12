import { randomUUID } from 'node:crypto';

import type { SqliteHandle } from './database.js';
import { decimalSequence } from '../publication/json.js';

/**
 * The paired substrate's own identity and the durable marker the guard-node creation reads.
 *
 * The singleton comes from reading and inserting inside one immediate transaction, not from
 * the id being random: two processes opening a fresh substrate at the same instant serialize
 * on that transaction, and the one that loses observes the row the other wrote and joins it.
 *
 * `bootstrapState` is what makes guard creation conditional. While it reads 'pairing' the
 * initial bootstrap is provably unfinished and the guard may be created. Once it reads
 * 'initialized' a missing guard is an inconsistency to report, and a migration runner that
 * replays its statements on every open must not mint a second guard over the top of it.
 *
 * The two revisions answer two different gates. `activationCapabilityRevision` is the coverage
 * capability the substrate has established and is what the coverage activation publication
 * names. `evictionCompatibilityRevision` is the destructive capability's arming fence, and a
 * substrate whose coverage is active still reads zero here.
 *
 * `evictionDisarmedAt` is the stop beside that fence, and it wins over the number. A stamp here
 * means somebody armed this substrate and then took it back, which is a different fact from
 * never having armed it and has to stay readable as one.
 */
export type SubstratePairing = {
  readonly substrateId: string;
  readonly bootstrapState: 'pairing' | 'initialized';
  readonly protocolVersion: number;
  readonly lastAckSequence: string;
  readonly pendingOperationId: string | null;
  readonly lastKnownFrom: string | null;
  readonly activationCapabilityRevision: number;
  readonly evictionCompatibilityRevision: number;
  readonly evictionDisarmedAt: string | null;
};

type PairingRowData = {
  substrate_id: string;
  bootstrap_state: 'pairing' | 'initialized';
  protocol_version: number;
  last_ack_sequence: string;
  pending_operation_id: string | null;
  last_known_from: string | null;
  activation_capability_revision: number;
  eviction_compatibility_revision: number;
  eviction_disarmed_at: string | null;
};

const SELECT_PAIRING = `SELECT substrate_id, bootstrap_state, protocol_version, CAST(last_ack_sequence AS TEXT) AS last_ack_sequence,
    pending_operation_id, last_known_from, activation_capability_revision,
    eviction_compatibility_revision, eviction_disarmed_at
  FROM publication_control LIMIT 1`;

function toPairing(row: PairingRowData): SubstratePairing {
  return {
    substrateId: row.substrate_id,
    bootstrapState: row.bootstrap_state,
    protocolVersion: row.protocol_version,
    lastAckSequence: row.last_ack_sequence,
    pendingOperationId: row.pending_operation_id,
    lastKnownFrom: row.last_known_from,
    activationCapabilityRevision: row.activation_capability_revision,
    evictionCompatibilityRevision: row.eviction_compatibility_revision,
    evictionDisarmedAt: row.eviction_disarmed_at,
  };
}

export function readSubstratePairing(db: SqliteHandle): SubstratePairing | undefined {
  const row = db.prepare(SELECT_PAIRING).get() as PairingRowData | undefined;
  return row === undefined ? undefined : toPairing(row);
}

/**
 * Returns the substrate's pairing row, minting it on the first call and joining it on every
 * one after. A caller that finds the state already 'initialized' has nothing to bootstrap.
 */
export function beginSubstratePairing(db: SqliteHandle, protocolVersion: number): SubstratePairing {
  return db
    .transaction((): SubstratePairing => {
      const existing = readSubstratePairing(db);
      if (existing !== undefined) {
        return existing;
      }
      const substrateId = randomUUID();
      db.prepare(
        `INSERT INTO publication_control (substrate_id, bootstrap_state, protocol_version)
         VALUES (?, 'pairing', ?)`,
      ).run(substrateId, protocolVersion);
      return {
        substrateId,
        bootstrapState: 'pairing',
        protocolVersion,
        lastAckSequence: '0',
        pendingOperationId: null,
        lastKnownFrom: null,
        activationCapabilityRevision: 0,
        evictionCompatibilityRevision: 0,
        evictionDisarmedAt: null,
      };
    })
    .immediate();
}

/**
 * Closes the initial bootstrap. From here a missing guard is reported rather than replaced,
 * so the transition happens only once the guard actually exists. Returns false when the row
 * was already initialized, which is an interrupted bootstrap finishing twice.
 */
export function completeSubstratePairing(db: SqliteHandle, substrateId: string): boolean {
  const result = db
    .prepare(
      `UPDATE publication_control SET bootstrap_state = 'initialized'
       WHERE substrate_id = ? AND bootstrap_state = 'pairing'`,
    )
    .run(substrateId);
  return result.changes === 1;
}

/**
 * Moves the acknowledgment cursor forward. A lower sequence is ignored rather than applied:
 * the cursor is what a recovery reads to find out how far acknowledgment got, and a cursor
 * that can move backwards would hide work that already completed.
 */
export function advanceAckCursor(db: SqliteHandle, sequence: string, knownFrom: string): boolean {
  decimalSequence(sequence);
  const result = db
    .prepare(
      `UPDATE publication_control SET last_ack_sequence = ?, last_known_from = ?
       WHERE last_ack_sequence < ?`,
    )
    .run(sequence, knownFrom, sequence);
  return result.changes === 1;
}

/** Names the operation whose acknowledgment this substrate is waiting on, or clears it. */
export function setPendingOperation(db: SqliteHandle, operationId: string | undefined): void {
  db.prepare('UPDATE publication_control SET pending_operation_id = ?').run(operationId ?? null);
}

/**
 * Records the coverage capability this build establishes, and answers with the revision in
 * force. The activation publication reads the recorded revision back and refuses a request that
 * names a different one, so the number has to be durable before the request is made rather than
 * carried in it.
 *
 * It only ever moves upward, and the answer is whatever the row holds afterwards. A build that
 * meets a higher recorded revision is meeting a capability a later build established, and
 * writing its own number over the top would let it activate against a contract it does not
 * implement.
 *
 * This is the coverage gate and nothing else. The eviction fence on the same row is a separate
 * column with its own writer above, reached only from an operator's explicit arming act.
 */
/**
 * Records the destructive capability an operator has deliberately armed, and answers with the
 * revision in force.
 *
 * The eviction fence. A substrate reads zero here until somebody arms it, and while it reads
 * zero `durableEligibility` answers `compatibility_not_established` for every source, so the
 * eviction operation removes nothing. This is the only production writer of that column, and it
 * is reached from one place: the acknowledge path of the arming publication, which is an audited
 * operation with a receipt. A second writer would arm the capability silently.
 *
 * Upward only, on the coverage writer's rule and for the same reason: a recorded revision above
 * this one is a capability a later build established, and writing a lower number over it would
 * re-enable a contract this build does not implement.
 */
export function establishEvictionCompatibility(db: SqliteHandle, revision: number): number {
  if (!Number.isSafeInteger(revision) || revision <= 0) {
    throw new Error('eviction compatibility revision must be a positive safe integer');
  }
  return db
    .transaction((): number => {
      db.prepare(
        `UPDATE publication_control SET eviction_compatibility_revision = ?
         WHERE eviction_compatibility_revision < ?`,
      ).run(revision, revision);
      // Arming is what un-stops a stopped substrate, in the same act and the same transaction.
      // A substrate left armed by the number and stopped by the stamp would refuse every
      // eviction while reporting itself armed, which is the worst of both readings.
      db.prepare('UPDATE publication_control SET eviction_disarmed_at = NULL').run();
      const pairing = readSubstratePairing(db);
      if (pairing === undefined) {
        throw new Error('no publication control record to arm');
      }
      return pairing.evictionCompatibilityRevision;
    })
    .immediate();
}

/**
 * Stops eviction, and leaves the record that it was armed.
 *
 * The counterpart to arming, and deliberately not its inverse: the revision is untouched, so the
 * capability this substrate established stays readable and a later arming cannot be mistaken for
 * a first one. What this writes is a separate durable fact that eviction reads first.
 *
 * It stops future evictions. It does not and cannot undo one that already happened: an eviction
 * removed a projection under a receipt, and nothing here puts it back.
 */
export function recordEvictionDisarm(db: SqliteHandle, disarmedAt: string): string | null {
  return db
    .transaction((): string | null => {
      db.prepare(
        'UPDATE publication_control SET eviction_disarmed_at = ? WHERE eviction_disarmed_at IS NULL',
      ).run(disarmedAt);
      const pairing = readSubstratePairing(db);
      if (pairing === undefined) {
        throw new Error('no publication control record to disarm');
      }
      return pairing.evictionDisarmedAt;
    })
    .immediate();
}

export function establishActivationCapability(db: SqliteHandle, revision: number): number {
  if (!Number.isSafeInteger(revision) || revision <= 0) {
    throw new Error('coverage activation capability must be a positive safe integer');
  }
  return db
    .transaction((): number => {
      db.prepare(
        `UPDATE publication_control SET activation_capability_revision = ?
         WHERE activation_capability_revision < ?`,
      ).run(revision, revision);
      const pairing = readSubstratePairing(db);
      if (pairing === undefined) {
        throw new Error('no publication control record to establish a capability on');
      }
      return pairing.activationCapabilityRevision;
    })
    .immediate();
}
