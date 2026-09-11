import type { ColumnAddition } from './column-additions.js';

/** Capture is resumable, but only the completed census becomes a frozen cohort. */
export const NARRATIVE_MIGRATION_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS narrative_migration_jobs (
    cohort_id TEXT PRIMARY KEY,
    phase TEXT NOT NULL CHECK (phase IN ('archive','graph','verify','order','inventory','census','partition','publish','cutover','complete')),
    revision INTEGER NOT NULL DEFAULT 0,
    cursor TEXT NOT NULL DEFAULT '',
    blocked_reason TEXT,
    retry_at TEXT,
    repair_resume_phase TEXT CHECK (repair_resume_phase IN ('inventory','census')),
    pass_progress_json TEXT,
    prior_gap_digest TEXT,
    lifecycle_state TEXT NOT NULL DEFAULT 'running' CHECK (lifecycle_state IN ('running','blocked','complete','abandoned') AND (lifecycle_state <> 'blocked' OR blocked_reason IS NOT NULL)),
    intake_watermark INTEGER NOT NULL,
    archive_rowid_low INTEGER NOT NULL,
    archive_rowid_high INTEGER NOT NULL,
    policy_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS narrative_migration_capture (
    cohort_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    archive_seen INTEGER NOT NULL DEFAULT 0 CHECK (archive_seen IN (0,1)),
    graph_seen INTEGER NOT NULL DEFAULT 0 CHECK (graph_seen IN (0,1)),
    PRIMARY KEY (cohort_id, source_id)
  )`,
  `CREATE TABLE IF NOT EXISTS narrative_migration_issues (
    cohort_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    active INTEGER NOT NULL CHECK (active IN (0,1)),
    retry_failures INTEGER NOT NULL DEFAULT 0 CHECK (retry_failures BETWEEN 0 AND 9007199254740991),
    PRIMARY KEY (cohort_id, phase, subject_id)
  )`,
] as const;

export const NARRATIVE_MIGRATION_COLUMN_ADDITIONS: readonly ColumnAddition[] = [
  {
    table: 'narrative_migration_issues',
    column: 'retry_failures',
    definition: 'INTEGER NOT NULL DEFAULT 0 CHECK (retry_failures BETWEEN 0 AND 9007199254740991)',
  },
  { table: 'narrative_migration_jobs', column: 'retry_at', definition: 'TEXT' },
  {
    table: 'narrative_migration_jobs',
    column: 'repair_resume_phase',
    definition: "TEXT CHECK (repair_resume_phase IN ('inventory','census'))",
  },
  { table: 'narrative_migration_jobs', column: 'pass_progress_json', definition: 'TEXT' },
  { table: 'narrative_migration_jobs', column: 'prior_gap_digest', definition: 'TEXT' },
  { table: 'narrative_migration_jobs', column: 'blocked_reason', definition: 'TEXT' },
  {
    table: 'narrative_migration_jobs',
    column: 'lifecycle_state',
    definition:
      "TEXT NOT NULL DEFAULT 'running' CHECK (lifecycle_state IN ('running','blocked','complete','abandoned') AND (lifecycle_state <> 'blocked' OR blocked_reason IS NOT NULL))",
  },
];
export const NARRATIVE_MIGRATION_INDEX_STATEMENTS = [
  'CREATE INDEX IF NOT EXISTS migration_progress_partition ON migration_progress (partition_assignment, cohort_id)',
] as const;
