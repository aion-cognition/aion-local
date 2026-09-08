import type { SqliteHandle } from './database.js';

/**
 * Connections that answer the capability probe the way a binary without FTS5 and a damaged
 * store answer it. Both are proxies over a real handle, so everything the probe does not touch
 * behaves exactly as it does in production.
 */

function intercept(db: SqliteHandle, failure: (sql: string) => Error | undefined): SqliteHandle {
  return new Proxy(db, {
    get(target, property, receiver): unknown {
      if (property === 'exec') {
        return (sql: string): unknown => {
          const err = failure(sql);
          if (err !== undefined) {
            throw err;
          }
          return target.exec(sql);
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

/** What SQLite says when the module was never compiled in. */
export function withoutFts5(db: SqliteHandle): SqliteHandle {
  return intercept(db, (sql) =>
    /USING\s+fts5/i.test(sql) ? new Error('no such module: fts5') : undefined,
  );
}

/** A store that has the module and cannot be read, which is a different repair entirely. */
export function withCorruptFts5(db: SqliteHandle): SqliteHandle {
  return intercept(db, (sql) =>
    /USING\s+fts5/i.test(sql) ? new Error('database disk image is malformed') : undefined,
  );
}
