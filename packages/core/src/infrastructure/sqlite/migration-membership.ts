import type { SqliteHandle } from './database.js';
import { ACTIVE_MIGRATION_JOB } from './narrative-migration-state.js';

/** Historical initial publication belongs to its migration job, not the hourly seal budget. */
export const MIGRATION_OWNED_CHUNK = `EXISTS (SELECT 1 FROM migration_progress migration
  JOIN narrative_migration_jobs job ON job.cohort_id = migration.cohort_id
  WHERE migration.partition_assignment = c.chunk_id AND ${ACTIVE_MIGRATION_JOB})`;

/** All live remainder queries use r for the source record whose reservation they test. */
export const RESERVED_MIGRATION_SOURCE = `(EXISTS (
  SELECT 1 FROM migration_progress reserved
  JOIN migration_cohorts cohort ON cohort.cohort_id = reserved.cohort_id
  JOIN narrative_migration_jobs job ON job.cohort_id = reserved.cohort_id
  WHERE reserved.source_id = r.source_id AND reserved.partition_assignment IS NULL
    AND cohort.partition_policy_json IS NOT NULL AND ${ACTIVE_MIGRATION_JOB})
  OR EXISTS (SELECT 1 FROM narrative_migration_jobs job
    WHERE ${ACTIVE_MIGRATION_JOB} AND job.phase IN ('archive','graph') AND
      NOT EXISTS (SELECT 1 FROM ingest_log i WHERE i.source_id = r.source_id AND i.id > job.intake_watermark)))`;

/** Validates the saved historical order without substituting the live arrival cursor. */
export function migrationMemberProblem(
  db: SqliteHandle,
  input: {
    readonly sourceId: string;
    readonly cohortId: string;
    readonly sessionId: string;
    readonly order: string;
    readonly policyVersion: number;
  },
): string | undefined {
  const row = db
    .prepare(
      `SELECT m.status, m.partition_gap, m.capture_order_value, s.session_id, s.verification_status,
    json_extract(c.partition_policy_json, '$.partitionPolicyVersion') AS policy
    FROM migration_progress m JOIN migration_cohorts c ON c.cohort_id = m.cohort_id
    JOIN source_records s ON s.source_id = m.source_id
    WHERE m.cohort_id = ? AND m.source_id = ?`,
    )
    .get(input.cohortId, input.sourceId) as
    | {
        status: string;
        partition_gap: string | null;
        capture_order_value: string | null;
        session_id: string;
        verification_status: string;
        policy: number | null;
      }
    | undefined;
  if (
    row?.status !== 'verified' ||
    row.verification_status !== 'verified' ||
    row.partition_gap !== null
  ) {
    return 'has no verified migration membership';
  }
  if (
    row.session_id !== input.sessionId ||
    row.policy !== input.policyVersion ||
    row.capture_order_value !== input.order
  ) {
    return 'moved outside the saved migration partition';
  }
  return undefined;
}
