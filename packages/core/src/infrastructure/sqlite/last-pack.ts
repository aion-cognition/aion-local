import type { SqliteHandle } from './database.js';

export type LastPack = {
  sessionId: string;
  pack: unknown;
  /** The stored row's JSON exactly as written, for callers that must reproduce it byte-for-byte. */
  packJson: string;
  ts: string;
  /** Present when the pack answered a time-traveled read; a reader of `aion last` must see that. */
  asOf?: string;
  knewAt?: string;
};

export type LastPackReadMode = {
  readonly asOf?: string;
  readonly knewAt?: string;
};

export type LastPackSession = {
  sessionId: string;
  ts: string;
};

type LastPackRow = {
  session_id: string;
  pack_json: string;
  ts: string;
  as_of: string | null;
  knew_at: string | null;
};

/** One row per session: a later call for the same sessionId replaces the prior pack. */
export function saveLastPack(
  db: SqliteHandle,
  sessionId: string,
  pack: unknown,
  ts: string = new Date().toISOString(),
  readMode: LastPackReadMode = {},
): void {
  db.prepare(
    `INSERT INTO last_pack (session_id, pack_json, ts, as_of, knew_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET pack_json = excluded.pack_json, ts = excluded.ts,
       as_of = excluded.as_of, knew_at = excluded.knew_at`,
  ).run(sessionId, JSON.stringify(pack), ts, readMode.asOf ?? null, readMode.knewAt ?? null);
}

export function getLastPack(db: SqliteHandle, sessionId: string): LastPack | undefined {
  const row = db.prepare('SELECT * FROM last_pack WHERE session_id = ?').get(sessionId) as
    LastPackRow | undefined;
  if (row === undefined) {
    return undefined;
  }
  return {
    sessionId: row.session_id,
    pack: JSON.parse(row.pack_json) as unknown,
    packJson: row.pack_json,
    ts: row.ts,
    ...(row.as_of === null ? {} : { asOf: row.as_of }),
    ...(row.knew_at === null ? {} : { knewAt: row.knew_at }),
  };
}

/** Every session with a saved pack, most recently served first (ISO timestamps sort lexicographically). */
export function listLastPackSessions(db: SqliteHandle): LastPackSession[] {
  const rows = db.prepare('SELECT session_id, ts FROM last_pack ORDER BY ts DESC').all() as {
    session_id: string;
    ts: string;
  }[];
  return rows.map((row) => ({ sessionId: row.session_id, ts: row.ts }));
}
