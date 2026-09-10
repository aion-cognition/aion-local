import { PUBLICATION_PROTOCOL_VERSION, type CheckpointResult } from './types.js';
import type { SqliteHandle } from '../sqlite/database.js';
import { coordinatorControl } from '../sqlite/publication-coordinator-store.js';

/**
 * The publication position an inspection may certify against, read and nothing else.
 *
 * A read that decides nothing still needs to know whether the substrate was settled while it
 * read: a publication in flight means what it saw may already be superseded, and a caller told
 * "complete for use" under one would be told something nobody established. The ordinary
 * coordinator answers that by reading the graph receipt, taking a position it may later have to
 * recover; an inspection may do neither, so this reads the position the store itself records and
 * stops there.
 *
 * What it certifies is the acknowledged position this store holds and whether a publication is
 * pending. What it does not certify is the paired graph receipt, which only the coordinator's own
 * checkpoint reads. Two readings that disagree still say the substrate moved under the read,
 * which is what an inspection needs from a position and the whole of what it may take.
 */
export function recordedPosition(db: SqliteHandle): CheckpointResult {
  let control;
  try {
    control = coordinatorControl(db);
  } catch {
    // No pairing, or more than one: an inspection cannot say where this substrate stands, and a
    // reading taken against nothing may not be reported as certified.
    return { status: 'unavailable', reason: 'store_unavailable' };
  }
  if (control.pendingOperationId !== null) {
    return { status: 'unavailable', reason: 'pending_publication' };
  }
  // A record written under another protocol version is one this reader cannot say it understands,
  // which is a control state it may not certify against rather than one it may reinterpret.
  if (control.protocolVersion !== PUBLICATION_PROTOCOL_VERSION) {
    return { status: 'unavailable', reason: 'publication_protocol_mismatch' };
  }
  return {
    status: 'ready',
    checkpoint: {
      substrateId: control.substrateId,
      protocolVersion: PUBLICATION_PROTOCOL_VERSION,
      sequence: control.lastAckSequence,
      operationId: null,
      intentDigest: null,
      resultDigest: null,
    },
  };
}
