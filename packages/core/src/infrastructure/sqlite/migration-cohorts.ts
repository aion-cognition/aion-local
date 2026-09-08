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

/** The header a retry has to repeat exactly, since the membership is the denominator it describes. */
function headerMatches(frozen: MigrationCohort, freeze: CohortFreeze): boolean {
  return (
    frozen.cohortDigest === freeze.cohortDigest &&
    frozen.intakeWatermark === freeze.intakeWatermark &&
    frozen.archiveRowidLow === freeze.archiveRowidLow &&
    frozen.archiveRowidHigh === freeze.archiveRowidHigh &&
    frozen.graphCensusDigest === freeze.graphCensusDigest &&
    frozen.orderingPolicyVersion === freeze.orderingPolicyVersion
  );
}

function frozenMembers(db: SqliteHandle, cohortId: string): ReadonlySet<string> {
  const rows = db
    .prepare('SELECT source_id FROM migration_progress WHERE cohort_id = ?')
    .all(cohortId) as { source_id: string }[];
  return new Set(rows.map((row) => row.source_id));
}

function sameMembers(frozen: ReadonlySet<string>, supplied: readonly string[]): boolean {
  const asked = new Set(supplied);
  return asked.size === frozen.size && [...asked].every((sourceId) => frozen.has(sourceId));
}

/**
 * Writes the cohort and its whole membership in one transaction, so a restart between the two
 * cannot leave a cohort whose members are unknowable, and an existing cohort row therefore
 * proves its members were written too.
 *
 * Only the first call establishes the enumeration. A repeat reads the frozen record first and
 * writes no member at all: the header records what the membership was counted over, so adding a
 * source from a fresher census under the old digest and bounds would leave a denominator that
 * describes a set nobody enumerated. A repeat that carries a different header or a different
 * member set is refused rather than half-applied; a source that arrived since the freeze belongs
 * to the tail, and a resumed pass updates progress rather than re-freezing.
 *
 * Returns the number of members written, which is zero for every repeat.
 */
export function freezeMigrationCohort(db: SqliteHandle, freeze: CohortFreeze): number {
  return db
    .transaction((): number => {
      const frozen = readMigrationCohort(db, freeze.cohortId);
      if (frozen !== undefined) {
        if (!headerMatches(frozen, freeze)) {
          throw new Error(`cohort ${freeze.cohortId} is already frozen under a different census`);
        }
        if (!sameMembers(frozenMembers(db, freeze.cohortId), freeze.members)) {
          throw new Error(
            `cohort ${freeze.cohortId} is already frozen over a different member set`,
          );
        }
        return 0;
      }

      db.prepare(
        `INSERT INTO migration_cohorts
           (cohort_id, cohort_digest, intake_watermark, archive_rowid_low, archive_rowid_high,
            graph_census_digest, ordering_policy_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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

/** Where one source sits in the live ingest order, or nothing when it has not been recorded. */
export function readIngestPosition(db: SqliteHandle, sourceId: string): number | undefined {
  const row = db.prepare('SELECT id FROM ingest_log WHERE source_id = ?').get(sourceId) as
    { id: number } | undefined;
  return row?.id;
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

/** Every frozen cohort, oldest first, which is the order a consumer walks them in. */
export function listMigrationCohorts(db: SqliteHandle): readonly string[] {
  const rows = db
    .prepare('SELECT cohort_id FROM migration_cohorts ORDER BY created_at, cohort_id')
    .all() as { cohort_id: string }[];
  return rows.map((row) => row.cohort_id);
}

/**
 * Cohort members a live enumeration cannot reach, oldest first by source id.
 *
 * The live order is the ingest log, and a legacy source frozen into a cohort never went through
 * it: it was already there when the cohort was taken. Selecting on the log alone therefore
 * skips exactly the population the migration exists for, so the frozen membership is its own
 * cursor. Source id orders it because the cohort's membership is fixed at the freeze and a
 * source's id does not move.
 */
export function listCohortSourcesAfter(
  db: SqliteHandle,
  cohortId: string,
  afterSourceId: string,
  limit: number,
  filter: { readonly sourceId?: string; readonly sessionId?: string } = {},
): readonly { readonly sourceId: string; readonly canonicalArchiveId: string | null }[] {
  const clauses: string[] = [];
  const parameters: unknown[] = [cohortId, afterSourceId];
  if (filter.sourceId !== undefined) {
    clauses.push('AND r.source_id = ?');
    parameters.push(filter.sourceId);
  }
  if (filter.sessionId !== undefined) {
    clauses.push('AND r.session_id = ?');
    parameters.push(filter.sessionId);
  }
  const rows = db
    .prepare(
      `SELECT r.source_id, r.canonical_archive_id
       FROM migration_progress m
       JOIN source_records r ON r.source_id = m.source_id
       WHERE m.cohort_id = ? AND m.source_id > ? ${clauses.join(' ')}
         AND NOT EXISTS (SELECT 1 FROM ingest_log i WHERE i.source_id = m.source_id)
       ORDER BY m.source_id
       LIMIT ?`,
    )
    .all(...parameters, limit) as {
    source_id: string;
    canonical_archive_id: string | null;
  }[];
  return rows.map((row) => ({
    sourceId: row.source_id,
    canonicalArchiveId: row.canonical_archive_id,
  }));
}
