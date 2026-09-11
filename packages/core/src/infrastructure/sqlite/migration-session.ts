import { readChunk } from './chunk-manifest.js';
import type { SqliteHandle } from './database.js';
import { readMigrationCohort } from './migration-cohorts.js';
import { readMigrationPolicy } from './migration-partition.js';
import { hashContent } from '../../reflection/domain/content.js';

/** A cutover reads at most this many frozen members and chunk heads under the guard. */
export const MIGRATION_SESSION_LIMIT = 2048;
export const CUTOVER_CHUNK_LIMIT = 128;

export type CutoverPartition = {
  readonly digest: string;
  readonly sourceCount: number;
  readonly chunkIds: readonly string[];
  readonly heads: readonly {
    readonly chunkId: string;
    readonly revisionNo: number;
    readonly nodeId: string;
  }[];
  readonly reason?: string;
};

/** The fixed partition, not the live remainder, is the completion denominator. */
export function readCutoverPartition(
  db: SqliteHandle,
  cohortId: string,
  sessionId: string,
): CutoverPartition {
  const cohort = readMigrationCohort(db, cohortId);
  const policy = readMigrationPolicy(db, cohortId);
  const rows = db
    .prepare(
      `SELECT m.source_id, m.status, m.partition_assignment, m.partition_gap,
      s.verification_status FROM migration_progress m JOIN source_records s ON s.source_id = m.source_id
      WHERE m.cohort_id = ? AND s.session_id = ? ORDER BY m.source_id LIMIT ?`,
    )
    .all(cohortId, sessionId, MIGRATION_SESSION_LIMIT + 1) as {
    source_id: string;
    status: string;
    partition_assignment: string | null;
    partition_gap: string | null;
    verification_status: string;
  }[];
  const gap = (reason: string): CutoverPartition => ({
    digest: '',
    sourceCount: rows.length,
    chunkIds: [],
    heads: [],
    reason,
  });
  if (cohort === undefined || policy === undefined) {
    return gap('partition_not_frozen');
  }
  const unmapped = db
    .prepare(
      `SELECT 1 FROM migration_progress m LEFT JOIN source_records s ON s.source_id = m.source_id
      WHERE m.cohort_id = ? AND (m.status = 'accounted' OR s.source_id IS NULL) LIMIT 1`,
    )
    .get(cohortId);
  if (unmapped !== undefined) {
    return gap('cohort_inventory_incomplete');
  }
  if (rows.length === 0 || rows.length > MIGRATION_SESSION_LIMIT) {
    return gap(rows.length === 0 ? 'partition_empty' : 'partition_member_bound');
  }
  if (
    rows.some(
      (r) =>
        r.status !== 'verified' || r.verification_status !== 'verified' || r.partition_gap !== null,
    )
  ) {
    return gap('partition_member_unverified');
  }
  if (rows.some((r) => r.partition_assignment === null)) {
    return gap('partition_not_complete');
  }
  const chunkIds = [
    ...new Set(
      rows.flatMap((r) => (r.partition_assignment === null ? [] : [r.partition_assignment])),
    ),
  ].sort();
  if (chunkIds.length > CUTOVER_CHUNK_LIMIT) {
    return gap('partition_chunk_bound');
  }
  const heads: { chunkId: string; revisionNo: number; nodeId: string }[] = [];
  for (const chunkId of chunkIds) {
    const chunk = readChunk(db, chunkId);
    const expected = rows
      .filter((r) => r.partition_assignment === chunkId)
      .map((r) => r.source_id)
      .sort();
    const members = db
      .prepare('SELECT source_id FROM chunk_members WHERE chunk_id = ? ORDER BY source_id LIMIT ?')
      .all(chunkId, expected.length + 1) as { source_id: string }[];
    if (
      chunk?.sessionId !== sessionId ||
      chunk.partitionPolicyVersion !== policy.partitionPolicyVersion ||
      JSON.stringify(members.map((r) => r.source_id)) !== JSON.stringify(expected)
    ) {
      return gap('partition_membership_changed');
    }
    const head = db
      .prepare(
        `SELECT r.revision_no, r.node_id FROM chunk_revisions r
      JOIN publication_intents i ON i.operation_id = r.operation_id
      WHERE r.chunk_id = ? AND r.state = 'published' AND i.state = 'acknowledged'
        AND r.known_from IS NOT NULL AND r.known_from = i.known_from`,
      )
      .get(chunkId) as { revision_no: number; node_id: string } | undefined;
    if (head?.revision_no === undefined || chunk.publishedRevisionNo !== head.revision_no) {
      return gap('partition_chunk_unpublished');
    }
    heads.push({ chunkId, revisionNo: head.revision_no, nodeId: head.node_id });
  }
  return {
    digest: hashContent({
      cohort: cohort.cohortDigest,
      policy,
      members: rows.map((r) => [r.source_id, r.partition_assignment]),
      heads,
    }),
    sourceCount: rows.length,
    chunkIds,
    heads,
  };
}
