import { chunkOfSource, readChunk } from './chunk-manifest.js';
import type { SqliteHandle } from './database.js';
import { recordMigrationProgress } from './migration-cohorts.js';
import { migrationMemberProblem } from './migration-membership.js';
import { readMigrationPolicy, type MigrationOrderedSource } from './migration-partition.js';
import { MIGRATION_SESSION_LIMIT } from './migration-session.js';

export type SessionPosition = { readonly sessionId: string; readonly members: number };

/** Fixed cohort counts put small sessions first without using world time as an arrival clock. */
export function nextMigrationSession(
  db: SqliteHandle,
  cohortId: string,
  after?: SessionPosition,
): SessionPosition | undefined {
  const row = db
    .prepare(
      `SELECT s.session_id, COUNT(*) AS members
    FROM migration_progress m JOIN source_records s ON s.source_id = m.source_id
    WHERE m.cohort_id = ? GROUP BY s.session_id
    HAVING COUNT(*) > ? OR (COUNT(*) = ? AND s.session_id > ?)
    ORDER BY members, s.session_id LIMIT 1`,
    )
    .get(cohortId, after?.members ?? -1, after?.members ?? -1, after?.sessionId ?? '') as
    { session_id: string; members: number } | undefined;
  return row === undefined ? undefined : { sessionId: row.session_id, members: row.members };
}

export function nextMigrationSource(
  db: SqliteHandle,
  cohortId: string,
  after: string,
  orderOnly = false,
): string | undefined {
  const row = db
    .prepare(
      `SELECT source_id FROM migration_progress WHERE cohort_id = ? AND source_id > ?
    ${orderOnly ? "AND status = 'verified' AND capture_order_value IS NULL" : ''}
    ORDER BY source_id LIMIT 1`,
    )
    .get(cohortId, after) as { source_id: string } | undefined;
  return row?.source_id;
}

export function nextMigrationChunk(
  db: SqliteHandle,
  cohortId: string,
  after: string,
): string | undefined {
  const row = db
    .prepare(
      `SELECT DISTINCT partition_assignment AS chunk_id FROM migration_progress
    WHERE cohort_id = ? AND partition_assignment IS NOT NULL AND partition_assignment > ?
    ORDER BY chunk_id LIMIT 1`,
    )
    .get(cohortId, after) as { chunk_id: string } | undefined;
  return row?.chunk_id;
}

export function unassignedOrderedMembers(db: SqliteHandle, cohortId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM migration_progress m JOIN source_records s ON s.source_id = m.source_id
    WHERE m.cohort_id = ? AND m.status = 'verified' AND s.verification_status = 'verified'
      AND m.capture_order_value IS NOT NULL AND m.partition_gap IS NULL AND m.partition_assignment IS NULL`,
    )
    .get(cohortId) as { n: number };
  return row.n;
}

/** These populations overlap: an ordering gap is separate from raw verification and publication. */
export function migrationRemainders(
  db: SqliteHandle,
  cohortId: string,
): { partitionGaps: number; unassignedSources: number; unpublishedChunks: number } {
  const row = db
    .prepare(
      `SELECT
    COUNT(CASE WHEN m.partition_gap IS NOT NULL THEN 1 END) AS gaps,
    COUNT(CASE WHEN m.partition_assignment IS NULL THEN 1 END) AS unassigned,
    COUNT(DISTINCT CASE WHEN c.published_revision_no IS NULL THEN m.partition_assignment END) AS unpublished
    FROM migration_progress m LEFT JOIN chunks c ON c.chunk_id = m.partition_assignment
    WHERE m.cohort_id = ?`,
    )
    .get(cohortId) as { gaps: number; unassigned: number; unpublished: number };
  return {
    partitionGaps: row.gaps,
    unassignedSources: row.unassigned,
    unpublishedChunks: row.unpublished,
  };
}

/** A chunk sealed before the capture reservation is adopted whole, never repartitioned. */
export function adoptExistingMigrationChunk(
  db: SqliteHandle,
  cohortId: string,
  sourceId: string,
): string | undefined {
  const chunkId = chunkOfSource(db, sourceId);
  if (chunkId === undefined) {
    return undefined;
  }
  return db
    .transaction(() => {
      const chunk = readChunk(db, chunkId);
      if (chunk === undefined) {
        throw new Error('a sealed source has no chunk record');
      }
      if (chunk.memberCount > MIGRATION_SESSION_LIMIT) {
        throw new Error('existing chunk exceeds the migration membership bound');
      }
      const policy = readMigrationPolicy(db, cohortId);
      if (policy?.partitionPolicyVersion !== chunk.partitionPolicyVersion) {
        throw new Error('existing chunk belongs to a different partition policy');
      }
      const members = (
        db
          .prepare(
            'SELECT source_id FROM chunk_members WHERE chunk_id = ? ORDER BY member_ordinal LIMIT ?',
          )
          .all(chunkId, MIGRATION_SESSION_LIMIT + 1) as { source_id: string }[]
      ).map((row) => row.source_id);
      if (members.length !== chunk.memberCount) {
        throw new Error('existing chunk membership exceeds or disagrees with its recorded bound');
      }
      for (const member of members) {
        const row = db
          .prepare(
            `SELECT capture_order_value FROM migration_progress
        WHERE cohort_id = ? AND source_id = ?`,
          )
          .get(cohortId, member) as { capture_order_value: string | null } | undefined;
        const problem = migrationMemberProblem(db, {
          sourceId: member,
          cohortId,
          sessionId: chunk.sessionId,
          order: row?.capture_order_value ?? '',
          policyVersion: chunk.partitionPolicyVersion,
        });
        if (problem !== undefined) {
          throw new Error(`existing chunk ${chunkId}: ${problem}`);
        }
      }
      for (const member of members) {
        recordMigrationProgress(db, {
          cohortId,
          sourceId: member,
          status: 'verified',
          partitionAssignment: chunkId,
        });
      }
      return chunkId;
    })
    .immediate();
}

/** Preserves the exact measured membership while selecting its saved metadata rows. */
export function chosenMigrationMembers(
  rows: readonly MigrationOrderedSource[],
  sourceIds: readonly string[],
): readonly MigrationOrderedSource[] {
  const byId = new Map(rows.map((row) => [row.sourceId, row]));
  return sourceIds.map((sourceId) => {
    const row = byId.get(sourceId);
    if (row === undefined) {
      throw new Error('measured migration member is absent from its ordered page');
    }
    return row;
  });
}
