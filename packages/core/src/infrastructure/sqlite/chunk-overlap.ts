import type { SqliteHandle } from './database.js';

/** What a bounded overlap read found, and whether the bound cut it short. */
type OverlapAnnotation = {
  readonly chunkIds: readonly string[];
  readonly truncated: boolean;
};

/**
 * Earlier chunks of this session whose members' world-time span holds a member of `sourceIds`.
 *
 * The condition is F13 D6's: an arrival whose world time falls inside a sealed chunk's span does
 * not repartition it. It is asked of EVERY new member, not only the earliest one. A membership
 * that opens before an old chunk and reaches into it overlaps that chunk on its later member, and
 * testing the earliest arrival alone answered for a moment no old span contained and stored
 * nothing — the annotation was silently empty exactly where a backdated arrival made it matter.
 *
 * One row past the bound is asked for so the caller can say the list is partial. A bounded read
 * is what this is; presenting it as the complete set would be the claim it cannot support.
 */
export function overlappingChunks(
  db: SqliteHandle,
  sessionId: string,
  sourceIds: readonly string[],
  limit: number,
): OverlapAnnotation {
  const placeholders = new Array(sourceIds.length).fill('?').join(', ');
  const rows = db
    .prepare(
      `SELECT s.chunk_id AS chunk_id
         FROM (SELECT c.chunk_id AS chunk_id, c.sealed_at AS sealed_at,
                      MIN(r.occurred_at) AS span_start, MAX(r.occurred_at) AS span_end
                 FROM chunks c
                 JOIN chunk_members m ON m.chunk_id = c.chunk_id
                 JOIN source_records r ON r.source_id = m.source_id
                WHERE c.session_id = ?
                GROUP BY c.chunk_id) s
        WHERE EXISTS (SELECT 1
                        FROM source_records n
                       WHERE n.source_id IN (${placeholders})
                         AND n.occurred_at >= s.span_start
                         AND n.occurred_at <= s.span_end)
        ORDER BY s.sealed_at, s.chunk_id
        LIMIT ?`,
    )
    .all(sessionId, ...sourceIds, limit + 1) as { chunk_id: string }[];
  return {
    chunkIds: rows.slice(0, limit).map((row) => row.chunk_id),
    truncated: rows.length > limit,
  };
}
