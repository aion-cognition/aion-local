import type { SqliteHandle } from './database.js';
import { PublicationInvariantError } from '../publication/errors.js';

/** A graph lock must not be held through the connection's ordinary long busy timeout. */
export function publicationWrite<T>(db: SqliteHandle, work: () => T): T {
  if (db.inTransaction) {
    throw new PublicationInvariantError('enclosing_sqlite_transaction');
  }
  const timeout: unknown = db.pragma('busy_timeout', { simple: true });
  if (typeof timeout !== 'number' || !Number.isInteger(timeout)) {
    throw new PublicationInvariantError('invalid_sqlite_busy_timeout');
  }
  db.pragma('busy_timeout = 0');
  try {
    return db
      .transaction(() => {
        const value = work();
        if (
          value !== null &&
          (typeof value === 'object' || typeof value === 'function') &&
          'then' in value
        ) {
          throw new PublicationInvariantError('async_sqlite_effect');
        }
        return value;
      })
      .immediate();
  } finally {
    db.pragma(`busy_timeout = ${timeout}`);
  }
}
