import type { SqliteHandle } from './database.js';

/**
 * Generic key/value store. Graph schema migration versions live here under their own
 * keys; this module makes no assumption about what those keys are.
 */
export function getMeta(db: SqliteHandle, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    { value: string } | undefined;
  return row?.value;
}

export function setMeta(db: SqliteHandle, key: string, value: string): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}
