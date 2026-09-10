import type { Driver } from 'neo4j-driver';

import { PublicationInvariantError, PublicationUnavailable } from './errors.js';
import { readPairedPosition } from './paired-position.js';
import { checkpointFrom, sameCheckpoint, verifyPublicationState } from './protocol.js';
import type { PublicationTransactions } from './transaction.js';
import type { CheckpointResult, PublicationCheckpoint, PublicationContext } from './types.js';
import type { SqliteHandle } from '../sqlite/database.js';
import { publicationWrite } from '../sqlite/publication-bounded.js';
import { coordinatorControl } from '../sqlite/publication-coordinator-store.js';

export type ReadCompletion<T> =
  | { readonly status: 'completed'; readonly value: T }
  | { readonly status: 'retry'; readonly reason: string };
export type SynchronousResult<T> = T & (T extends PromiseLike<unknown> ? never : unknown);
type ReadOptions = {
  readonly driver: Driver;
  readonly db: SqliteHandle;
  readonly transactions: PublicationTransactions;
  readonly timeoutMs: number;
  readonly now: () => Date;
};

/** Certification is separate from nomination and never initiates publication recovery. */
export class PublicationReadBarrier {
  readonly #options: ReadOptions;
  constructor(options: ReadOptions) {
    this.#options = options;
  }

  /**
   * The same paired reading an inspection may take, which is why it lives beside both callers
   * rather than inside this class. Nothing about it changed in the move: no lock, no recovery
   * ownership, no initialization, no repair.
   */
  async checkpoint(): Promise<CheckpointResult> {
    const { db, driver, timeoutMs } = this.#options;
    return readPairedPosition({ db, driver, timeoutMs });
  }

  /**
   * Validate with graph reads only. The guard transaction always rolls back, including on success;
   * only the synchronous SQLite completion callback persists effects. Graph writes belong in a publication.
   */
  async complete<T>(
    checkpoint: PublicationCheckpoint,
    validate: (context: PublicationContext) => Promise<boolean>,
    complete: (db: SqliteHandle) => SynchronousResult<T>,
  ): Promise<ReadCompletion<T>> {
    try {
      return await this.#complete(checkpoint, validate, complete);
    } catch (err) {
      return {
        status: 'retry',
        reason: err instanceof PublicationUnavailable ? err.reason : 'store_unavailable',
      };
    }
  }

  async #complete<T>(
    checkpoint: PublicationCheckpoint,
    validate: (context: PublicationContext) => Promise<boolean>,
    complete: (db: SqliteHandle) => SynchronousResult<T>,
  ): Promise<ReadCompletion<T>> {
    const { db, now, transactions } = this.#options;
    if (coordinatorControl(db).pendingOperationId !== null) {
      return { status: 'retry', reason: 'pending_publication' };
    }
    return transactions.run(
      'complete_read',
      async (lock) => {
        const state = verifyPublicationState(db, lock.receipt);
        if (
          state.pending !== undefined ||
          !sameCheckpoint(checkpoint, checkpointFrom(lock.receipt))
        ) {
          return { status: 'retry', reason: 'publication_changed' };
        }
        if (
          !(await validate({
            operationId: 'read_completion',
            sequence: null,
            graph: lock.graph,
            db,
            now: now(),
          }))
        ) {
          return { status: 'retry', reason: 'evidence_changed' };
        }
        const value = publicationWrite(db, () => {
          const current = coordinatorControl(db);
          if (
            current.pendingOperationId !== null ||
            current.lastAckSequence !== checkpoint.sequence
          ) {
            throw new PublicationInvariantError('publication_changed_during_completion');
          }
          return complete(db);
        });
        return { status: 'completed', value };
      },
      this.#options.timeoutMs,
    );
  }
}
