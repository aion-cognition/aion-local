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
 */
export type SubstratePairing = {
  readonly substrateId: string;
  readonly bootstrapState: 'pairing' | 'initialized';
  readonly protocolVersion: number;
  readonly lastAckSequence: string;
  readonly pendingOperationId: string | null;
  readonly lastKnownFrom: string | null;
  readonly activationCapabilityRevision: number;
};

type PairingRowData = {
  substrate_id: string;
  bootstrap_state: 'pairing' | 'initialized';
  protocol_version: number;
  last_ack_sequence: string;
  pending_operation_id: string | null;
  last_known_from: string | null;
  activation_capability_revision: number;
};

const SELECT_PAIRING = `SELECT substrate_id, bootstrap_state, protocol_version, CAST(last_ack_sequence AS TEXT) AS last_ack_sequence,
    pending_operation_id, last_known_from, activation_capability_revision
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
