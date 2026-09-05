import type { SqliteHandle } from './database.js';

/**
 * The record of what a session has already been handed. Everything a recall renders stays in
 * that session's conversation, so serving it a second time spends tokens on text the agent is
 * still reading. This table is what lets the next recall subtract it.
 *
 * Every item a pack rendered gets a row, and so does every repeat it withheld, since the agent
 * still holds a withheld repeat from the recall that first served it. An item a bucket cap or
 * the token budget cut has no row, so the next recall offers it in full.
 */

export type ServedItem = {
  readonly itemId: string;
  /** What the item said when it was served. A different value means it has changed since. */
  readonly fingerprint: string;
};

type ServedRow = {
  item_id: string;
  fingerprint: string;
};

/** Every item this session already holds, keyed by node id. Empty for a session with no history. */
export function readServedItems(db: SqliteHandle, sessionId: string): ReadonlyMap<string, string> {
  const rows = db
    .prepare('SELECT item_id, fingerprint FROM served_items WHERE session_id = ?')
    .all(sessionId) as ServedRow[];
  return new Map(rows.map((row) => [row.item_id, row.fingerprint]));
}

/**
 * One row per item, written after assembly so the record names what the agent received. A
 * re-serve refreshes the fingerprint and the last-served stamp and leaves `first_served_at`
 * alone. Nothing selects `first_served_at` today; it is kept so a later forensic read can say
 * when a session first learned a memory.
 */
export function recordServedItems(
  db: SqliteHandle,
  sessionId: string,
  items: readonly ServedItem[],
  servedAt: string,
): void {
  if (items.length === 0) {
    return;
  }
  const insert = db.prepare(
    `INSERT INTO served_items (session_id, item_id, fingerprint, first_served_at, last_served_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(session_id, item_id) DO UPDATE SET fingerprint = excluded.fingerprint,
       last_served_at = excluded.last_served_at`,
  );
  const writeAll = db.transaction((batch: readonly ServedItem[]) => {
    for (const item of batch) {
      insert.run(sessionId, item.itemId, item.fingerprint, servedAt, servedAt);
    }
  });
  writeAll(items);
}

/** One item a pack handed out, with the earliest moment any session received it. */
export type ServedItemAge = {
  readonly itemId: string;
  readonly firstServedAt: string;
};

/**
 * Items first served before `cutoff`, one row per item rather than per (session, item): the
 * question a caller asks of this is whether serving a memory led anywhere, and the first serve
 * is when that clock starts. Two sessions holding the same item are one item here.
 *
 * The rows are a live-context record, so a session's rows go when it closes and the idle purge
 * takes the rest: what survives long enough to read here is what a still-running conversation
 * was handed. That makes this a small read on a healthy substrate and an empty one on a quiet
 * install, which is a real answer rather than a gap.
 */
export function listServedItemsBefore(
  db: SqliteHandle,
  cutoff: string,
  limit: number,
): readonly ServedItemAge[] {
  const rows = db
    .prepare(
      `SELECT item_id, MIN(first_served_at) AS first_served_at
       FROM served_items
       GROUP BY item_id
       HAVING MIN(first_served_at) < ?
       ORDER BY first_served_at ASC
       LIMIT ?`,
    )
    .all(cutoff, limit) as { item_id: string; first_served_at: string }[];
  return rows.map((row) => ({ itemId: row.item_id, firstServedAt: row.first_served_at }));
}

/**
 * Drops the whole record for one session, and answers how many rows went. The rows describe an
 * agent's live context, so they are worthless the moment that context is gone.
 */
export function deleteServedItems(db: SqliteHandle, sessionId: string): number {
  return db.prepare('DELETE FROM served_items WHERE session_id = ?').run(sessionId).changes;
}

/**
 * The backstop for a session no close will ever name: a process killed mid-session, or a
 * restart, leaves rows behind that the session map no longer knows about. A session is judged
 * on its newest row rather than row by row, since one long conversation can serve a memory in
 * its first minute and still be running hours later.
 */
export function purgeServedItemsIdleSince(db: SqliteHandle, cutoff: string): number {
  return db
    .prepare(
      `DELETE FROM served_items WHERE session_id IN (
         SELECT session_id FROM served_items GROUP BY session_id HAVING MAX(last_served_at) < ?
       )`,
    )
    .run(cutoff).changes;
}
