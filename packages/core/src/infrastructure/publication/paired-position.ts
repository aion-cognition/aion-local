import type { Driver } from 'neo4j-driver';

import { PublicationInvariantError, PublicationUnavailable } from './errors.js';
import { checkpointFrom, sameCheckpoint, verifyPublicationState } from './protocol.js';
import type { CheckpointResult } from './types.js';
import { readPublicationGuard } from '../graph/publication-receipt.js';
import type { SqliteHandle } from '../sqlite/database.js';
import { coordinatorControl } from '../sqlite/publication-coordinator-store.js';

/**
 * The position a read may certify against: the graph receipt and the SQLite acknowledgment as a
 * matched pair, with no publication prepared in between.
 *
 * This is the algorithm the publication read barrier has always used, lifted so an inspection can
 * hold the same position rather than a weaker synthesis of one. It reads and nothing else: it
 * takes no lock, claims no recovery ownership, initializes nothing and repairs nothing, so a
 * caller that is only answering a question can ask it. Every state that cannot be paired — a
 * pairing still bootstrapping, a receipt from another substrate, an acknowledged sequence with no
 * record behind it — raises its own invariant and comes back as a decline rather than a position.
 */

/**
 * The bound a read applies to the receipt query. It is the coordinator's own default for the
 * same read (`coordinator.ts`), stated here so an inspection that holds no coordinator asks
 * under the same bound rather than inventing one.
 */
export const PAIRED_POSITION_TIMEOUT_MS = 1000;

export type PairedPositionDeps = {
  readonly driver: Driver;
  readonly db: SqliteHandle;
  readonly timeoutMs: number;
};

export async function readPairedPosition(deps: PairedPositionDeps): Promise<CheckpointResult> {
  const { db, driver, timeoutMs } = deps;
  try {
    if (db.inTransaction) {
      throw new PublicationInvariantError('enclosing_sqlite_transaction');
    }
    const before = coordinatorControl(db);
    if (before.pendingOperationId !== null) {
      return { status: 'unavailable', reason: 'pending_publication' };
    }
    const guard = await readPublicationGuard(driver, before.substrateId, timeoutMs);
    const state = verifyPublicationState(db, guard);
    if (
      state.pending !== undefined ||
      state.control.lastAckSequence !== before.lastAckSequence ||
      state.control.substrateId !== before.substrateId
    ) {
      return { status: 'unavailable', reason: 'publication_changed' };
    }
    return { status: 'ready', checkpoint: checkpointFrom(guard) };
  } catch (err) {
    return {
      status: 'unavailable',
      reason: err instanceof PublicationUnavailable ? err.reason : 'store_unavailable',
    };
  }
}

/**
 * What two readings of the position say about the interval between them, in the coordinator's own
 * words: nothing when the same pair was settled at both ends, and otherwise the reason the later
 * reading gives, or that the pair moved.
 *
 * A read holds its position across work the caller does, and the answer it assembled is only as
 * settled as the interval that produced it. Reading once at the start certifies the beginning of
 * that interval and says nothing about its end.
 */
export function positionDrift(
  before: CheckpointResult,
  after: CheckpointResult,
): string | undefined {
  if (after.status === 'unavailable') {
    return after.reason;
  }
  if (before.status === 'unavailable') {
    return before.reason;
  }
  return sameCheckpoint(before.checkpoint, after.checkpoint) ? undefined : 'publication_changed';
}
