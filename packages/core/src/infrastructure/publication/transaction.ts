import neo4j, { type Driver, type Transaction } from 'neo4j-driver';
import { performance } from 'node:perf_hooks';

import { PublicationInvariantError } from './errors.js';
import { verifyPublicationState } from './protocol.js';
import type { PublicationMetric } from './types.js';
import { GraphTransaction } from '../graph/connection.js';
import { lockPublicationGuard, type GuardReceipt } from '../graph/publication-receipt.js';
import type { Logger } from '../logging/logger.js';
import type { SqliteHandle } from '../sqlite/database.js';
import { coordinatorControl } from '../sqlite/publication-coordinator-store.js';

export type LockedPublication = {
  readonly graph: GraphTransaction;
  readonly receipt: GuardReceipt;
  readonly acquiredAt: number;
  committedAt?: number;
  commit(): Promise<void>;
};
type TransactionOptions = {
  readonly driver: Driver;
  readonly db: SqliteHandle;
  readonly logger: Pick<Logger, 'warn'>;
  readonly now: () => Date;
  readonly timeoutMs: number;
  readonly observe?: (metric: PublicationMetric) => void;
};

/** Native transactions have no managed-driver retry that could replay a SQLite effect. */
export class PublicationTransactions {
  readonly #options: TransactionOptions;
  constructor(options: TransactionOptions) {
    this.#options = options;
  }

  async run<T>(
    operation: PublicationMetric['operation'],
    work: (lock: LockedPublication) => Promise<T>,
    deadlineMs: number = this.#options.timeoutMs,
  ): Promise<T> {
    const { db, driver, logger, now } = this.#options;
    if (db.inTransaction) {
      throw new PublicationInvariantError('enclosing_sqlite_transaction');
    }
    const started = performance.now();
    const control = coordinatorControl(db);
    const session = driver.session({ defaultAccessMode: neo4j.session.WRITE });
    let native: Transaction | undefined;
    let lock: LockedPublication | undefined;
    let outcome: PublicationMetric['outcome'] = 'failed';
    try {
      const active = await session.beginTransaction({ timeout: deadlineMs });
      native = active;
      const graph = new GraphTransaction(active);
      const receipt = await lockPublicationGuard(graph, control.substrateId, now());
      let commitStarted = false;
      const held: LockedPublication = {
        graph,
        receipt,
        acquiredAt: performance.now(),
        commit: async () => {
          if (db.inTransaction || commitStarted) {
            throw new PublicationInvariantError('invalid_publication_commit_boundary');
          }
          commitStarted = true;
          await active.commit();
          held.committedAt = performance.now();
        },
      };
      lock = held;
      verifyPublicationState(db, receipt);
      const result = await work(held);
      outcome = 'complete';
      return result;
    } finally {
      try {
        if (native !== undefined && lock?.committedAt === undefined) {
          await native.rollback();
        }
      } catch (err) {
        logger.warn({ err }, 'publication transaction release failed');
      }
      try {
        await session.close();
      } catch (err) {
        logger.warn({ err }, 'publication session release failed');
      }
      if (lock !== undefined) {
        try {
          this.#options.observe?.({
            operation,
            outcome,
            waitMs: lock.acquiredAt - started,
            holdMs: (lock.committedAt ?? performance.now()) - lock.acquiredAt,
          });
        } catch (err) {
          logger.warn({ err }, 'publication metric observer failed');
        }
      }
    }
  }
}
