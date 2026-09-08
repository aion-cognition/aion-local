import type { SqliteHandle } from './database.js';

/**
 * Freezing a legacy cohort and walking it.
 *
 * The bounds are captured once and are separate from the live intake watermark, so the cohort
 * is reproducible and the gap between the frozen scan and the live stream is closed rather
 * than assumed away. The membership is written as rows before any verification pages: a digest
 * cross-checks an enumeration, and it cannot re-list the sources that exist only in the graph
 * after a restart.
 *
 * One source gets one progress row however many archive rows back it. Multiple rows of one
 * source are accounted through the frozen bounds and the alias list on the source record.
 */
export type CohortFreeze = {
  readonly cohortId: string;
  readonly cohortDigest: string;
  /** The live stream's position at the freeze, so the tail cohort starts exactly here. */
  readonly intakeWatermark: number;
  readonly archiveRowidLow: number;
  readonly archiveRowidHigh: number;
  readonly graphCensusDigest: string;
  readonly orderingPolicyVersion: number;
  readonly createdAt: Date;
  /** Every distinct source in the cohort, archive-backed and graph-only alike. */
  readonly members: readonly string[];
};

export type MigrationCohort = {
  readonly cohortId: string;
  readonly cohortDigest: string;
  readonly intakeWatermark: number;
  readonly archiveRowidLow: number;
  readonly archiveRowidHigh: number;
  readonly graphCensusDigest: string;
  readonly scanCursor: number | null;
  readonly orderingPolicyVersion: number;
};

type CohortRowData = {
  cohort_id: string;
  cohort_digest: string;
  intake_watermark: number;
  archive_rowid_low: number;
  archive_rowid_high: number;
  graph_census_digest: string;
  scan_cursor: number | null;
  ordering_policy_version: number;
};

export type MigrationStatus = 'accounted' | 'verified' | 'pinned';

/**
 * Writes the cohort and its whole membership in one transaction, so a restart between the two
 * cannot leave a cohort whose members are unknowable. Re-running it against the same cohort id
 * adds nothing: the rows are keyed and a member already accounted keeps whatever status the
 * scan has since given it.
 */
export function freezeMigrationCohort(db: SqliteHandle, freeze: CohortFreeze): number {
  return db
    .transaction((): number => {
      db.prepare(
        `INSERT INTO migration_cohorts
           (cohort_id, cohort_digest, intake_watermark, archive_rowid_low, archive_rowid_high,
            graph_census_digest, ordering_policy_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (cohort_id) DO NOTHING`,
      ).run(
        freeze.cohortId,
        freeze.cohortDigest,
        freeze.intakeWatermark,
        freeze.archiveRowidLow,
        freeze.archiveRowidHigh,
        freeze.graphCensusDigest,
        freeze.orderingPolicyVersion,
        freeze.createdAt.toISOString(),
      );

      const member = db.prepare(
        `INSERT INTO migration_progress (cohort_id, source_id, status)
         VALUES (?, ?, 'accounted')
         ON CONFLICT (cohort_id, source_id) DO NOTHING`,
      );
      let written = 0;
      for (const sourceId of freeze.members) {
        written += member.run(freeze.cohortId, sourceId).changes;
      }
      return written;
    })
    .immediate();
}

export function readMigrationCohort(
  db: SqliteHandle,
  cohortId: string,
): MigrationCohort | undefined {
  const row = db
    .prepare(
      `SELECT cohort_id, cohort_digest, intake_watermark, archive_rowid_low, archive_rowid_high,
              graph_census_digest, scan_cursor, ordering_policy_version
       FROM migration_cohorts WHERE cohort_id = ?`,
    )
    .get(cohortId) as CohortRowData | undefined;
  if (row === undefined) {
    return undefined;
  }
  return {
    cohortId: row.cohort_id,
    cohortDigest: row.cohort_digest,
    intakeWatermark: row.intake_watermark,
    archiveRowidLow: row.archive_rowid_low,
    archiveRowidHigh: row.archive_rowid_high,
    graphCensusDigest: row.graph_census_digest,
    scanCursor: row.scan_cursor,
    orderingPolicyVersion: row.ordering_policy_version,
  };
}

/**
 * Moves the resumable scan position forward. A cursor that could move backwards would make a
 * restart re-account rows the previous pass already finished.
 */
export function advanceCohortCursor(db: SqliteHandle, cohortId: string, cursor: number): boolean {
  const result = db
    .prepare(
      `UPDATE migration_cohorts SET scan_cursor = ?
       WHERE cohort_id = ? AND (scan_cursor IS NULL OR scan_cursor < ?)`,
    )
    .run(cursor, cohortId, cursor);
  return result.changes === 1;
}

export type MigrationProgressUpdate = {
  readonly cohortId: string;
  readonly sourceId: string;
  readonly status: MigrationStatus;
  readonly reason?: string;
  /** The chunk this source sealed into. Written once and never moved afterwards. */
  readonly partitionAssignment?: string;
};

/**
 * Records what the scan learned about one member. The partition assignment is immutable once
 * written: a better clock proof arriving later improves the evidence about a source and does
 * not move it between chunks, so an update carrying a different assignment is refused.
 */
export function recordMigrationProgress(db: SqliteHandle, update: MigrationProgressUpdate): void {
  db.transaction((): void => {
    const current = db
      .prepare(
        'SELECT partition_assignment FROM migration_progress WHERE cohort_id = ? AND source_id = ?',
      )
      .get(update.cohortId, update.sourceId) as { partition_assignment: string | null } | undefined;
    const committed = current?.partition_assignment ?? null;
    if (
      committed !== null &&
      update.partitionAssignment !== undefined &&
      update.partitionAssignment !== committed
    ) {
      throw new Error(
        `source ${update.sourceId} is already assigned to ${committed} in cohort ${update.cohortId}`,
      );
    }

    db.prepare(
      `INSERT INTO migration_progress (cohort_id, source_id, status, reason, partition_assignment)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (cohort_id, source_id) DO UPDATE SET
         status = excluded.status,
         reason = excluded.reason,
         partition_assignment = COALESCE(migration_progress.partition_assignment,
                                         excluded.partition_assignment)`,
    ).run(
      update.cohortId,
      update.sourceId,
      update.status,
      update.reason ?? null,
      update.partitionAssignment ?? null,
    );
  }).immediate();
}

export type MigrationProgressRow = {
  readonly sourceId: string;
  readonly status: MigrationStatus;
  readonly reason: string | null;
  readonly partitionAssignment: string | null;
};

export function readMigrationProgress(
  db: SqliteHandle,
  cohortId: string,
  sourceId: string,
): MigrationProgressRow | undefined {
  const row = db
    .prepare(
      `SELECT source_id, status, reason, partition_assignment FROM migration_progress
       WHERE cohort_id = ? AND source_id = ?`,
    )
    .get(cohortId, sourceId) as
    | {
        source_id: string;
        status: MigrationStatus;
        reason: string | null;
        partition_assignment: string | null;
      }
    | undefined;
  if (row === undefined) {
    return undefined;
  }
  return {
    sourceId: row.source_id,
    status: row.status,
    reason: row.reason,
    partitionAssignment: row.partition_assignment,
  };
}

/** How many members sit at each status, which is what a batch reports when it finishes. */
export function countMigrationProgress(
  db: SqliteHandle,
  cohortId: string,
): Record<MigrationStatus, number> {
  const rows = db
    .prepare(
      'SELECT status, count(*) AS n FROM migration_progress WHERE cohort_id = ? GROUP BY status',
    )
    .all(cohortId) as { status: MigrationStatus; n: number }[];
  const counts: Record<MigrationStatus, number> = { accounted: 0, verified: 0, pinned: 0 };
  for (const row of rows) {
    counts[row.status] = row.n;
  }
  return counts;
}

/** The live stream's current position, which is what a freeze captures as its watermark. */
export function readIntakeWatermark(db: SqliteHandle): number {
  const row = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM ingest_log').get() as {
    id: number;
  };
  return row.id;
}

/**
 * Appends a source to the live ingest order. Positions are never reused, so the watermark a
 * freeze captured stays a boundary a later arrival cannot slip behind.
 */
export function recordIngest(db: SqliteHandle, sourceId: string, recordedAt: Date): number {
  return db
    .transaction((): number => {
      const existing = db.prepare('SELECT id FROM ingest_log WHERE source_id = ?').get(sourceId) as
        { id: number } | undefined;
      if (existing !== undefined) {
        return existing.id;
      }
      const result = db
        .prepare('INSERT INTO ingest_log (source_id, recorded_at) VALUES (?, ?)')
        .run(sourceId, recordedAt.toISOString());
      return Number(result.lastInsertRowid);
    })
    .immediate();
}

/** Sources that arrived after the freeze: the tail the final reconciliation pass walks. */
export function listIngestAfter(
  db: SqliteHandle,
  watermark: number,
  limit: number,
): readonly { id: number; sourceId: string }[] {
  const rows = db
    .prepare('SELECT id, source_id FROM ingest_log WHERE id > ? ORDER BY id LIMIT ?')
    .all(watermark, limit) as { id: number; source_id: string }[];
  return rows.map((row) => ({ id: row.id, sourceId: row.source_id }));
}
