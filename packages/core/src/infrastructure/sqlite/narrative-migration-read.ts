import { chunkOfSource, readChunk } from './chunk-manifest.js';
import { DUE_INITIAL_CHUNK } from './chunk-publication-read.js';
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
  unresolvedOnly = false,
): string | undefined {
  const row = db
    .prepare(
      `SELECT source_id FROM migration_progress m WHERE cohort_id = ? AND source_id > ?
    ${unresolvedOnly ? "AND (m.status <> 'verified' OR NOT EXISTS (SELECT 1 FROM source_records s WHERE s.source_id = m.source_id AND s.verification_status = 'verified'))" : ''}
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
  now: Date,
): string | undefined {
  const row = db
    .prepare(
      `SELECT c.chunk_id FROM chunks c
    WHERE EXISTS (SELECT 1 FROM migration_progress m WHERE m.cohort_id = ? AND m.partition_assignment = c.chunk_id)
      AND c.chunk_id > ? AND ${DUE_INITIAL_CHUNK}
      AND NOT EXISTS (SELECT 1 FROM chunk_revisions a WHERE a.chunk_id = c.chunk_id
        AND (a.state = 'prepared' OR (a.state = 'allocated' AND a.claim_expires_at > ?)))
    ORDER BY c.chunk_id LIMIT 1`,
    )
    .get(cohortId, after, now.toISOString(), now.toISOString()) as { chunk_id: string } | undefined;
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

export type MigrationAdoption =
  | { readonly status: 'not_sealed' }
  | {
      readonly status: 'refused';
      readonly issues: readonly { readonly id: string; readonly reason: string }[];
    }
  | { readonly status: 'adopted'; readonly chunkId: string; readonly changed: boolean };

/** A chunk sealed before the capture reservation is adopted whole, never partly reassigned. */
export function adoptExistingMigrationChunk(
  db: SqliteHandle,
  cohortId: string,
  sourceId: string,
): MigrationAdoption {
  const chunkId = chunkOfSource(db, sourceId);
  if (chunkId === undefined) {
    return { status: 'not_sealed' };
  }
  return db
    .transaction((): MigrationAdoption => {
      const chunk = readChunk(db, chunkId);
      if (chunk === undefined) {
        return {
          status: 'refused',
          issues: [{ id: chunkId, reason: 'existing_chunk_record_missing' }],
        };
      }
      if (chunk.memberCount > MIGRATION_SESSION_LIMIT) {
        return {
          status: 'refused',
          issues: [{ id: chunkId, reason: 'existing_chunk_member_bound' }],
        };
      }
      const policy = readMigrationPolicy(db, cohortId);
      if (policy?.partitionPolicyVersion !== chunk.partitionPolicyVersion) {
        return {
          status: 'refused',
          issues: [{ id: chunkId, reason: 'existing_chunk_policy_mismatch' }],
        };
      }
      const members = (
        db
          .prepare(
            'SELECT source_id FROM chunk_members WHERE chunk_id = ? ORDER BY member_ordinal LIMIT ?',
          )
          .all(chunkId, MIGRATION_SESSION_LIMIT + 1) as { source_id: string }[]
      ).map((row) => row.source_id);
      if (members.length !== chunk.memberCount) {
        return {
          status: 'refused',
          issues: [{ id: chunkId, reason: 'existing_chunk_membership_unproved' }],
        };
      }
      const issues: { id: string; reason: string }[] = [];
      let changed = false;
      for (const member of members) {
        const row = db
          .prepare(
            'SELECT status, capture_order_value, partition_assignment, partition_gap, reason FROM migration_progress WHERE cohort_id = ? AND source_id = ?',
          )
          .get(cohortId, member) as
          | {
              status: string;
              capture_order_value: string | null;
              partition_assignment: string | null;
              partition_gap: string | null;
              reason: string | null;
            }
          | undefined;
        const problem = migrationMemberProblem(db, {
          sourceId: member,
          cohortId,
          sessionId: chunk.sessionId,
          order: row?.capture_order_value ?? '',
          policyVersion: chunk.partitionPolicyVersion,
        });
        if (problem !== undefined) {
          let reason = row?.partition_gap ?? problem;
          if (row?.status === 'pinned' && row.reason !== null) {
            ({ reason } = row);
          }
          issues.push({ id: member, reason });
        } else if (row?.partition_assignment != null && row.partition_assignment !== chunkId) {
          issues.push({ id: member, reason: 'existing_chunk_assignment_mismatch' });
        } else {
          changed ||= row?.partition_assignment == null;
        }
      }
      if (issues.length > 0) {
        return { status: 'refused', issues };
      }
      for (const member of members) {
        recordMigrationProgress(db, {
          cohortId,
          sourceId: member,
          status: 'verified',
          partitionAssignment: chunkId,
        });
      }
      return { status: 'adopted', chunkId, changed };
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
