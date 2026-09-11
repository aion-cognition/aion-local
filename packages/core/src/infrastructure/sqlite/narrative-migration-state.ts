import { z } from 'zod';

import type { SqliteHandle } from './database.js';

const State = z.enum(['running', 'blocked', 'complete', 'abandoned']);
export type NarrativeMigrationState = z.infer<typeof State>;
/** Every reservation reads this lifecycle predicate, including old rows whose phase is complete. */
export const ACTIVE_MIGRATION_JOB =
  "job.phase <> 'complete' AND job.lifecycle_state IN ('running','blocked')";

export function migrationState(phase: string, stored: unknown): NarrativeMigrationState {
  const state = stored === undefined || stored === null ? 'running' : State.parse(stored);
  if (state === 'running' && phase === 'complete') {
    return 'complete';
  }
  return state;
}

/** Abandoning retires scheduling authority, not accepted inputs, frozen membership or published output. */
export function abandonNarrativeMigration(
  db: SqliteHandle,
  cohortId: string,
  now: Date,
): NarrativeMigrationState | undefined {
  return db
    .transaction(() => {
      const row = db
        .prepare(
          'SELECT phase, lifecycle_state, revision FROM narrative_migration_jobs WHERE cohort_id = ?',
        )
        .get(cohortId) as { phase: string; lifecycle_state: string; revision: number } | undefined;
      if (row === undefined) {
        return undefined;
      }
      const state = migrationState(row.phase, row.lifecycle_state);
      if (state === 'complete' || state === 'abandoned') {
        return state;
      }
      if (!Number.isSafeInteger(row.revision) || row.revision >= Number.MAX_SAFE_INTEGER) {
        throw new Error('migration revision reached its exact-integer bound');
      }
      db.prepare(
        "UPDATE narrative_migration_jobs SET lifecycle_state = 'abandoned', revision = revision + 1, updated_at = ? WHERE cohort_id = ?",
      ).run(now.toISOString(), cohortId);
      return 'abandoned';
    })
    .immediate();
}

/** The cursor stays at the uncompleted action; a stale runner cannot block or revive another state. */
export function holdNarrativeMigration(
  db: SqliteHandle,
  job: { readonly cohortId: string; readonly phase: string; readonly revision: number },
  reason: string,
  now: Date,
): boolean {
  if (!Number.isSafeInteger(job.revision) || job.revision >= Number.MAX_SAFE_INTEGER) {
    throw new Error('migration revision reached its exact-integer bound');
  }
  return (
    db
      .prepare(
        "UPDATE narrative_migration_jobs SET lifecycle_state = 'blocked', blocked_reason = ?, revision = revision + 1, updated_at = ? WHERE cohort_id = ? AND phase = ? AND revision = ? AND lifecycle_state = 'running'",
      )
      .run(reason, now.toISOString(), job.cohortId, job.phase, job.revision).changes === 1
  );
}

/** Re-entry retains completed verification and inventory; only unresolved evidence goes through the producer again. */
export function refreshNarrativeMigration(
  db: SqliteHandle,
  job: { readonly cohortId: string; readonly phase: string; readonly revision: number },
  now: Date,
): boolean {
  if (!Number.isSafeInteger(job.revision) || job.revision >= Number.MAX_SAFE_INTEGER) {
    throw new Error('migration revision reached its exact-integer bound');
  }
  const held = db
    .prepare(
      'SELECT blocked_reason, repair_resume_phase FROM narrative_migration_jobs WHERE cohort_id = ?',
    )
    .get(job.cohortId) as
    { blocked_reason: string | null; repair_resume_phase: string | null } | undefined;
  if (held?.blocked_reason === 'capture_member_bound') {
    return false;
  }
  const afterInventory =
    ['census', 'partition', 'publish', 'cutover', 'complete'].includes(job.phase) ||
    held?.repair_resume_phase === 'census';
  const capture = job.phase === 'archive' || job.phase === 'graph';
  const repairResume = afterInventory ? 'census' : 'inventory';
  return db
    .transaction(() => {
      const changed =
        db
          .prepare(
            "UPDATE narrative_migration_jobs SET lifecycle_state = 'running', blocked_reason = NULL, retry_at = NULL, repair_resume_phase = ?, pass_progress_json = NULL, prior_gap_digest = NULL, phase = ?, cursor = CASE WHEN ? THEN cursor ELSE '' END, revision = revision + 1, updated_at = ? WHERE cohort_id = ? AND revision = ? AND lifecycle_state <> 'abandoned'",
          )
          .run(
            capture ? null : repairResume,
            capture ? job.phase : 'verify',
            capture ? 1 : 0,
            now.toISOString(),
            job.cohortId,
            job.revision,
          ).changes === 1;
      if (changed) {
        db.prepare('UPDATE narrative_migration_issues SET active = 0 WHERE cohort_id = ?').run(
          job.cohortId,
        );
      }
      return changed;
    })
    .immediate();
}
