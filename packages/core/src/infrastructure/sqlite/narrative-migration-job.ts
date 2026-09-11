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
  rememberMigrationPolicy,
  type MigrationPartitionPolicy,
} from './migration-partition.js';
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
  const policy = parseMigrationPartitionPolicy(input.policy);
  return db
    .transaction(() => {
      const held = readNarrativeMigration(db, input.cohortId);
      if (held !== undefined) {
        if (JSON.stringify(held.policy) !== JSON.stringify(policy)) {
          throw new Error('a narrative migration cannot change its frozen policy');
        }
        return held;
      }
      const frozen = readMigrationCohort(db, input.cohortId);
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
        `UPDATE narrative_migration_jobs SET phase = ?, cursor = ?, revision = revision + 1, updated_at = ?
      WHERE cohort_id = ? AND phase = ? AND revision = ?`,
      )
      .run(phase, cursor, now.toISOString(), job.cohortId, job.phase, job.revision).changes === 1
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
      if (current?.revision !== job.revision || current.phase !== job.phase) {
        return false;
      }
      const insert =
        db.prepare(`INSERT INTO narrative_migration_capture (cohort_id, source_id, archive_seen, graph_seen)
      VALUES (?, ?, ?, ?) ON CONFLICT(cohort_id, source_id) DO UPDATE SET
        archive_seen = MAX(archive_seen, excluded.archive_seen), graph_seen = MAX(graph_seen, excluded.graph_seen)`);
      for (const sourceId of sourceIds) {
        const arrived = readIngestPosition(db, sourceId);
        if (arrived === undefined || arrived <= job.intakeWatermark) {
          insert.run(
            job.cohortId,
            sourceId,
            job.phase === 'archive' ? 1 : 0,
            job.phase === 'graph' ? 1 : 0,
          );
        }
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
      if (current?.revision !== job.revision || current.phase !== 'graph') {
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
      const members = rows.map((row) => row.source_id);
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
          rows.filter((row) => row.graph_seen === 1).map((row) => row.source_id),
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
