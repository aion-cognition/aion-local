import type { SqliteHandle } from './database.js';

/**
 * The order sources arrived in, as a position per source.
 *
 * An acceptance takes the next position and keeps it. Positions are never reused and never move,
 * so a reader that recorded one is naming a boundary later arrivals sit past rather than a count
 * that shifts under it. The occurrence reader joins it to order captures that share a clock.
 */

/** The stream's current position: the highest recorded arrival. */
export function readIntakeWatermark(db: SqliteHandle): number {
  const row = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM ingest_log').get() as {
    id: number;
  };
  return row.id;
}

/** Appends a source to the arrival order, or answers with the position it already holds. */
export function recordIngest(db: SqliteHandle, sourceId: string, recordedAt: Date): number {
  return db
    .transaction((): number => {
      const existing = db.prepare('SELECT id FROM ingest_log WHERE source_id = ?').get(sourceId) as
        { id: number } | undefined;
      if (existing !== undefined) {
        return existing.id;
      }
      const result = db
        .prepare('INSERT INTO ingest_log (source_id, recorded_at) VALUES (?, ?)')
        .run(sourceId, recordedAt.toISOString());
      return Number(result.lastInsertRowid);
    })
    .immediate();
}

/** Where one source sits in the arrival order, or nothing when it has not been recorded. */
export function readIngestPosition(db: SqliteHandle, sourceId: string): number | undefined {
  const row = db.prepare('SELECT id FROM ingest_log WHERE source_id = ?').get(sourceId) as
    { id: number } | undefined;
  return row?.id;
}

/** Sources that arrived after a recorded position, oldest first. */
export function listIngestAfter(
  db: SqliteHandle,
  watermark: number,
  limit: number,
): readonly { id: number; sourceId: string }[] {
  const rows = db
    .prepare('SELECT id, source_id FROM ingest_log WHERE id > ? ORDER BY id LIMIT ?')
    .all(watermark, limit) as { id: number; source_id: string }[];
  return rows.map((row) => ({ id: row.id, sourceId: row.source_id }));
}
