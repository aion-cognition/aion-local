import type { SqliteHandle } from './database.js';

export type LastPack = {
  sessionId: string;
  pack: unknown;
  ts: string;
};

type LastPackRow = {
  session_id: string;
  pack_json: string;
  ts: string;
};

/** One row per session: a later call for the same sessionId replaces the prior pack. */
export function saveLastPack(
  db: SqliteHandle,
  sessionId: string,
  pack: unknown,
  ts: string = new Date().toISOString(),
): void {
  db.prepare(
    `INSERT INTO last_pack (session_id, pack_json, ts) VALUES (?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET pack_json = excluded.pack_json, ts = excluded.ts`,
  ).run(sessionId, JSON.stringify(pack), ts);
}

export function getLastPack(db: SqliteHandle, sessionId: string): LastPack | undefined {
  const row = db.prepare('SELECT * FROM last_pack WHERE session_id = ?').get(sessionId) as
    | LastPackRow
    | undefined;
  if (row === undefined) {
    return undefined;
  }
  return {
    sessionId: row.session_id,
    pack: JSON.parse(row.pack_json) as unknown,
    ts: row.ts,
  };
}
