import { SEAL_REMAINDER_POPULATION, type BlockedSourceTally } from './chunk-nomination.js';
import type { SqliteHandle } from './database.js';
import { MIGRATION_OWNED_CHUNK, RESERVED_MIGRATION_SOURCE } from './migration-membership.js';

/** Reservation removes live eligibility, never visibility. These reason populations can overlap other holds. */
export function migrationHeldSources(db: SqliteHandle): readonly BlockedSourceTally[] {
  const rows = db
    .prepare(
      `
    SELECT 'migration_reserved' AS reason, COUNT(*) AS sources, MIN(r.created_at) AS oldest_at
    FROM source_records r JOIN session_remainders s ON s.session_id = r.session_id
    WHERE ${RESERVED_MIGRATION_SOURCE} AND ${SEAL_REMAINDER_POPULATION}
    UNION ALL
    SELECT 'migration_owned' AS reason, COUNT(*) AS sources, MIN(c.sealed_at) AS oldest_at
    FROM chunks c JOIN chunk_members m ON m.chunk_id = c.chunk_id
    WHERE ${MIGRATION_OWNED_CHUNK}
  `,
    )
    .all() as { reason: string; sources: number; oldest_at: string | null }[];
  return rows.flatMap((row) =>
    row.sources === 0 || row.oldest_at === null
      ? []
      : [
          {
            reason: row.reason,
            sources: row.sources,
            oldestAt: row.oldest_at,
          },
        ],
  );
}
