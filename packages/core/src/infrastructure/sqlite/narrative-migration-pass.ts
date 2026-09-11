import { createHash } from 'node:crypto';

import type { SqliteHandle } from './database.js';
import {
  advanceNarrativeMigration,
  type NarrativeMigrationJob,
} from './narrative-migration-job.js';
import { holdNarrativeMigration } from './narrative-migration-state.js';

export type MigrationIssue = { readonly id: string; readonly reason: string };

/** A refusal is current evidence of a hold, not a new event every time the driver reads it. */
export function recordMigrationIssue(
  db: SqliteHandle,
  job: NarrativeMigrationJob,
  id: string,
  reason: string,
): void {
  db.prepare(
    `INSERT INTO narrative_migration_issues (cohort_id, phase, subject_id, reason, active)
    SELECT ?, ?, ?, ?, 1 WHERE EXISTS (SELECT 1 FROM narrative_migration_jobs
      WHERE cohort_id = ? AND revision = ? AND lifecycle_state = 'running')
    ON CONFLICT(cohort_id, phase, subject_id) DO UPDATE SET reason = excluded.reason, active = 1
  `,
  ).run(job.cohortId, job.phase, id, reason, job.cohortId, job.revision);
}

/** A bounded report states when further distinct issues remain. */
export function readMigrationIssues(
  db: SqliteHandle,
  cohortId: string,
  limit = 256,
): { issues: readonly MigrationIssue[]; issuesTruncated: boolean } {
  const rows = db
    .prepare(
      `SELECT DISTINCT subject_id AS id, reason FROM narrative_migration_issues
    WHERE cohort_id = ? AND active = 1 ORDER BY id, reason LIMIT ?`,
    )
    .all(cohortId, limit + 1) as MigrationIssue[];
  return { issues: rows.slice(0, limit), issuesTruncated: rows.length > limit };
}

/** Committed work is the progress measure, so a crash after publication cannot erase progress. */
function progress(db: SqliteHandle, cohortId: string): string {
  const row = db
    .prepare(
      `SELECT
    (SELECT COUNT(*) FROM migration_progress WHERE cohort_id = ? AND partition_assignment IS NOT NULL) AS assigned,
    (SELECT COUNT(DISTINCT c.chunk_id) FROM migration_progress m JOIN chunks c ON c.chunk_id = m.partition_assignment
      WHERE m.cohort_id = ? AND c.published_revision_no IS NOT NULL) AS published,
    (SELECT COUNT(DISTINCT s.session_id) FROM migration_progress m JOIN source_records s ON s.source_id = m.source_id
      WHERE m.cohort_id = ? AND EXISTS (SELECT 1 FROM family_selection_log f JOIN publication_intents i ON i.operation_id = f.operation_id
        WHERE f.session_id = s.session_id AND f.active_family = 'chunk' AND i.state = 'acknowledged')) AS selected
  `,
    )
    .get(cohortId, cohortId, cohortId);
  return JSON.stringify(row);
}

function current(db: SqliteHandle, job: NarrativeMigrationJob): boolean {
  return (
    db
      .prepare(
        "SELECT 1 FROM narrative_migration_jobs WHERE cohort_id = ? AND revision = ? AND lifecycle_state = 'running'",
      )
      .get(job.cohortId, job.revision) !== undefined
  );
}

/** Starts one complete partition/publication/cutover pass without clearing any source work. */
export function beginMigrationPass(db: SqliteHandle, job: NarrativeMigrationJob): void {
  db.transaction(() => {
    if (!current(db, job)) {
      return;
    }
    const changed = db
      .prepare(
        'UPDATE narrative_migration_jobs SET pass_progress_json = ? WHERE cohort_id = ? AND pass_progress_json IS NULL',
      )
      .run(progress(db, job.cohortId), job.cohortId).changes;
    if (changed > 0) {
      db.prepare(
        "UPDATE narrative_migration_issues SET active = 0 WHERE cohort_id = ? AND phase IN ('partition','publish','cutover')",
      ).run(job.cohortId);
    }
  }).immediate();
}

/** Names source holds even when no session can be established for a member of the frozen denominator. */
export function recordMigrationMemberIssues(db: SqliteHandle, job: NarrativeMigrationJob): void {
  db.prepare(
    `WITH problems AS (
SELECT m.source_id AS id,
    CASE WHEN s.source_id IS NULL THEN 'source_identity_unproved'
      WHEN m.status <> 'verified' THEN COALESCE(m.reason, 'source_verification_unproved')
      WHEN s.verification_status <> 'verified' THEN COALESCE(s.verification_reason, 'source_verification_unproved')
      WHEN m.partition_gap IS NOT NULL THEN m.partition_gap
      WHEN m.capture_order_value IS NULL THEN 'capture_order_unproved'
      WHEN m.partition_assignment IS NULL THEN 'partition_unassigned' END AS reason
    FROM migration_progress m LEFT JOIN source_records s ON s.source_id = m.source_id
    WHERE m.cohort_id = ? ORDER BY m.source_id
    ) INSERT INTO narrative_migration_issues (cohort_id, phase, subject_id, reason, active)
    SELECT ?, ?, id, reason, 1 FROM problems WHERE reason IS NOT NULL
      AND EXISTS (SELECT 1 FROM narrative_migration_jobs WHERE cohort_id = ? AND revision = ? AND lifecycle_state = 'running')
    ON CONFLICT(cohort_id, phase, subject_id) DO UPDATE SET reason = excluded.reason, active = 1
  `,
  ).run(job.cohortId, job.cohortId, job.phase, job.cohortId, job.revision);
}

function gapDigest(db: SqliteHandle, cohortId: string): string {
  const hash = createHash('sha256');
  const rows = db
    .prepare(
      `SELECT DISTINCT subject_id, reason FROM narrative_migration_issues
    WHERE cohort_id = ? AND active = 1 ORDER BY subject_id, reason`,
    )
    .iterate(cohortId);
  for (const row of rows) {
    hash.update(`${JSON.stringify(row)}\n`);
  }
  return hash.digest('hex');
}

/** Timed retries and live claims remain running; a blocked prerequisite never becomes due merely with time. */
function publicationWait(db: SqliteHandle, job: NarrativeMigrationJob, now: Date): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM migration_progress m JOIN chunks c ON c.chunk_id = m.partition_assignment
    JOIN chunk_revisions r ON r.chunk_id = c.chunk_id
    WHERE m.cohort_id = ? AND c.published_revision_no IS NULL
      AND (r.state = 'prepared' OR (r.state = 'allocated' AND r.blocked_reason IS NULL
        AND (r.next_attempt_at > ? OR r.claim_expires_at > ?))) LIMIT 1
  `,
      )
      .get(job.cohortId, now.toISOString(), now.toISOString()) !== undefined
  );
}

/** A repeated, unchanged full pass stops explicitly. It never declares any outstanding work complete. */
export function finishMigrationPass(
  db: SqliteHandle,
  job: NarrativeMigrationJob,
  allReady: boolean,
  now: Date,
): string | undefined {
  return db
    .transaction(() => {
      if (!current(db, job)) {
        return undefined;
      }
      recordMigrationMemberIssues(db, job);
      const unassigned = db
        .prepare(
          'SELECT 1 FROM migration_progress WHERE cohort_id = ? AND partition_assignment IS NULL LIMIT 1',
        )
        .get(job.cohortId);
      if (allReady && unassigned === undefined) {
        advanceNarrativeMigration(db, job, 'complete', '', now);
        return undefined;
      }
      if (publicationWait(db, job, now)) {
        advanceNarrativeMigration(db, job, 'publish', '', now);
        return 'publication_retry_wait';
      }
      const held = db
        .prepare(
          'SELECT pass_progress_json, prior_gap_digest FROM narrative_migration_jobs WHERE cohort_id = ?',
        )
        .get(job.cohortId) as {
        pass_progress_json: string | null;
        prior_gap_digest: string | null;
      };
      const digest = gapDigest(db, job.cohortId);
      if (
        held.pass_progress_json === progress(db, job.cohortId) &&
        held.prior_gap_digest === digest
      ) {
        holdNarrativeMigration(db, job, 'unchanged_blocking_evidence', now);
        return 'unchanged_blocking_evidence';
      }
      db.prepare(
        'UPDATE narrative_migration_jobs SET pass_progress_json = NULL, prior_gap_digest = ? WHERE cohort_id = ?',
      ).run(digest, job.cohortId);
      advanceNarrativeMigration(db, job, 'partition', '', now);
      return undefined;
    })
    .immediate();
}

/** The completed verification sweep can prove why census cannot advance; unchanged pins require repair. */
export function holdRepeatedCensusRefusal(
  db: SqliteHandle,
  job: NarrativeMigrationJob,
  now: Date,
): void {
  db.transaction(() => {
    if (!current(db, job)) {
      return;
    }
    recordMigrationMemberIssues(db, job);
    const digest = gapDigest(db, job.cohortId);
    const row = db
      .prepare('SELECT prior_gap_digest FROM narrative_migration_jobs WHERE cohort_id = ?')
      .get(job.cohortId) as { prior_gap_digest: string | null };
    if (row.prior_gap_digest === digest) {
      holdNarrativeMigration(db, job, 'cohort_not_fully_accounted', now);
    } else {
      db.prepare(
        'UPDATE narrative_migration_jobs SET prior_gap_digest = ? WHERE cohort_id = ?',
      ).run(digest, job.cohortId);
    }
  }).immediate();
}
