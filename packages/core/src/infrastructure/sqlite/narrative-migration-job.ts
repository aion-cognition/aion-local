import { z } from 'zod';

import type { SqliteHandle } from './database.js';
import { archiveRowidBounds } from './legacy-archive-scan.js';
import {
  freezeMigrationCohort,
  readIngestPosition,
  readIntakeWatermark,
  readMigrationCohort,
} from './migration-cohorts.js';
import {
  parseMigrationPartitionPolicy,
  readMigrationPolicy,
  rememberMigrationPolicy,
  type MigrationPartitionPolicy,
} from './migration-partition.js';
import { MigrationRefused } from './migration-refusal.js';
import {
  migrationState,
  holdNarrativeMigration,
  type NarrativeMigrationState,
} from './narrative-migration-state.js';
import { hashContent } from '../../reflection/domain/content.js';

const Phase = z.enum([
  'archive',
  'graph',
  'verify',
  'order',
  'inventory',
  'census',
  'partition',
  'publish',
  'cutover',
  'complete',
]);
export type NarrativeMigrationPhase = z.infer<typeof Phase>;
export const MIGRATION_COHORT_LIMIT = 65_536;

export type NarrativeMigrationJob = {
  readonly cohortId: string;
  readonly phase: NarrativeMigrationPhase;
  readonly state: NarrativeMigrationState;
  readonly blockedReason?: string;
  readonly revision: number;
  readonly cursor: string;
  readonly intakeWatermark: number;
  readonly archiveRowidLow: number;
  readonly archiveRowidHigh: number;
  readonly policy: MigrationPartitionPolicy;
};

export function readNarrativeMigration(
  db: SqliteHandle,
  cohortId: string,
): NarrativeMigrationJob | undefined {
  const row = db
    .prepare('SELECT * FROM narrative_migration_jobs WHERE cohort_id = ?')
    .get(cohortId) as
    | {
        cohort_id: string;
        phase: string;
        lifecycle_state?: string;
        blocked_reason?: string | null;
        revision: number;
        cursor: string;
        intake_watermark: number;
        archive_rowid_low: number;
        archive_rowid_high: number;
        policy_json: string;
      }
    | undefined;
  if (
    row !== undefined &&
    ![row.revision, row.intake_watermark, row.archive_rowid_low, row.archive_rowid_high].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    )
  ) {
    throw new Error('migration metadata contains an unsafe cursor value');
  }
  return row === undefined
    ? undefined
    : {
        cohortId: row.cohort_id,
        phase: Phase.parse(row.phase),
        state: migrationState(row.phase, row.lifecycle_state),
        ...(row.blocked_reason == null ? {} : { blockedReason: row.blocked_reason }),
        revision: row.revision,
        cursor: row.cursor,
        intakeWatermark: row.intake_watermark,
        archiveRowidLow: row.archive_rowid_low,
        archiveRowidHigh: row.archive_rowid_high,
        policy: parseMigrationPartitionPolicy(JSON.parse(row.policy_json)),
      };
}

/** The reservation and arrival boundary exist before the first asynchronous graph page. */
export function beginNarrativeMigration(
  db: SqliteHandle,
  input: {
    readonly cohortId: string;
    readonly policy: MigrationPartitionPolicy;
    readonly now: Date;
  },
): NarrativeMigrationJob {
  return db
    .transaction(() => {
      const held = readNarrativeMigration(db, input.cohortId);
      if (held !== undefined) {
        return held;
      }
      const frozen = readMigrationCohort(db, input.cohortId);
      const policy =
        readMigrationPolicy(db, input.cohortId) ?? parseMigrationPartitionPolicy(input.policy);
      if (frozen !== undefined && frozen.orderingPolicyVersion !== policy.partitionPolicyVersion) {
        throw new MigrationRefused(input.cohortId, 'migration_ordering_policy_mismatch');
      }
      const bounds = archiveRowidBounds(db);
      db.prepare(
        `INSERT INTO narrative_migration_jobs
      (cohort_id, phase, intake_watermark, archive_rowid_low, archive_rowid_high, policy_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.cohortId,
        frozen === undefined ? 'archive' : 'verify',
        frozen?.intakeWatermark ?? readIntakeWatermark(db),
        frozen?.archiveRowidLow ?? bounds.low,
        frozen?.archiveRowidHigh ?? bounds.high,
        JSON.stringify(policy),
        input.now.toISOString(),
        input.now.toISOString(),
      );
      if (frozen !== undefined) {
        rememberMigrationPolicy(db, input.cohortId, policy);
      }
      const created = readNarrativeMigration(db, input.cohortId);
      if (created === undefined) {
        throw new Error('migration creation did not persist its row');
      }
      return created;
    })
    .immediate();
}

/** A stale driver cannot overwrite a newer cursor or phase. This checkpoint discharges no source work. */
export function advanceNarrativeMigration(
  db: SqliteHandle,
  job: NarrativeMigrationJob,
  phase: NarrativeMigrationPhase,
  cursor: string,
  now: Date,
): boolean {
  if (job.revision >= Number.MAX_SAFE_INTEGER) {
    throw new Error('migration revision reached its exact-integer bound');
  }
  return (
    db
      .prepare(
        `UPDATE narrative_migration_jobs SET phase = ?, cursor = ?, lifecycle_state = CASE WHEN ? = 'complete' THEN 'complete' ELSE lifecycle_state END, revision = revision + 1, updated_at = ?
      WHERE cohort_id = ? AND phase = ? AND revision = ? AND lifecycle_state = 'running'`,
      )
      .run(phase, cursor, phase, now.toISOString(), job.cohortId, job.phase, job.revision)
      .changes === 1
  );
}

/** Persist examined members and the continuation together; verified post-boundary intake stays in the live tail. */
export function captureNarrativeMigrationPage(
  db: SqliteHandle,
  job: NarrativeMigrationJob,
  sourceIds: readonly string[],
  nextCursor: string,
  now: Date,
): boolean {
  if (job.phase !== 'archive' && job.phase !== 'graph') {
    throw new Error('source capture requires a capture phase');
  }
  return db
    .transaction(() => {
      const current = readNarrativeMigration(db, job.cohortId);
      if (
        current?.revision !== job.revision ||
        current.phase !== job.phase ||
        current.state !== 'running'
      ) {
        return false;
      }
      const eligible = [...new Set(sourceIds)].filter((sourceId) => {
        const arrived = readIngestPosition(db, sourceId);
        return arrived === undefined || arrived <= job.intakeWatermark;
      });
      const exists = db.prepare(
        'SELECT 1 FROM narrative_migration_capture WHERE cohort_id = ? AND source_id = ?',
      );
      const additions = eligible.filter(
        (sourceId) => exists.get(job.cohortId, sourceId) === undefined,
      ).length;
      if (countCapturedMigrationSources(db, job.cohortId) + additions > MIGRATION_COHORT_LIMIT) {
        holdNarrativeMigration(db, job, 'capture_member_bound', now);
        return false;
      }
      const insert =
        db.prepare(`INSERT INTO narrative_migration_capture (cohort_id, source_id, archive_seen, graph_seen)
        VALUES (?, ?, ?, ?) ON CONFLICT(cohort_id, source_id) DO UPDATE SET
        archive_seen = MAX(archive_seen, excluded.archive_seen), graph_seen = MAX(graph_seen, excluded.graph_seen)`);
      for (const sourceId of eligible) {
        insert.run(
          job.cohortId,
          sourceId,
          job.phase === 'archive' ? 1 : 0,
          job.phase === 'graph' ? 1 : 0,
        );
      }
      return advanceNarrativeMigration(db, job, job.phase, nextCursor, now);
    })
    .immediate();
}

/** The full captured membership becomes the frozen denominator in one metadata transaction. */
export function freezeNarrativeMigrationCapture(
  db: SqliteHandle,
  job: NarrativeMigrationJob,
  now: Date,
): boolean {
  return db
    .transaction(() => {
      const current = readNarrativeMigration(db, job.cohortId);
      if (
        current?.revision !== job.revision ||
        current.phase !== 'graph' ||
        current.state !== 'running'
      ) {
        return false;
      }
      const rows = db
        .prepare(
          `SELECT source_id, graph_seen FROM narrative_migration_capture
      WHERE cohort_id = ? ORDER BY source_id LIMIT ?`,
        )
        .all(job.cohortId, MIGRATION_COHORT_LIMIT + 1) as {
        source_id: string;
        graph_seen: number;
      }[];
      if (rows.length > MIGRATION_COHORT_LIMIT) {
        throw new Error('the migration cohort exceeds its metadata freeze bound');
      }
      const eligible = rows.filter((row) => {
        const arrived = readIngestPosition(db, row.source_id);
        return arrived === undefined || arrived <= job.intakeWatermark;
      });
      const members = eligible.map((row) => row.source_id);
      freezeMigrationCohort(db, {
        cohortId: job.cohortId,
        cohortDigest: hashContent({
          watermark: job.intakeWatermark,
          low: job.archiveRowidLow,
          high: job.archiveRowidHigh,
          members,
        }),
        intakeWatermark: job.intakeWatermark,
        archiveRowidLow: job.archiveRowidLow,
        archiveRowidHigh: job.archiveRowidHigh,
        graphCensusDigest: hashContent(
          eligible.filter((row) => row.graph_seen === 1).map((row) => row.source_id),
        ),
        orderingPolicyVersion: job.policy.partitionPolicyVersion,
        createdAt: now,
        members,
      });
      rememberMigrationPolicy(db, job.cohortId, job.policy);
      return advanceNarrativeMigration(db, job, 'verify', '', now);
    })
    .immediate();
}

/** The captured population is provisional until the fixed cohort is frozen. */
export function countCapturedMigrationSources(db: SqliteHandle, cohortId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM narrative_migration_capture WHERE cohort_id = ?')
    .get(cohortId) as { n: number };
  return row.n;
}
