import { IsoTimestampSchema } from '@aion/protocol';
import { z } from 'zod';

import { sealChunk, type ChunkSealOutcome } from './chunk-manifest.js';
import type { SqliteHandle } from './database.js';
import { readMigrationCohort, recordMigrationProgress } from './migration-cohorts.js';
import { migrationMemberProblem, RESERVED_MIGRATION_SOURCE } from './migration-membership.js';
import { MigrationRefused } from './migration-refusal.js';

export type MigrationPartitionPolicy = {
  readonly maxMembers: number;
  readonly renderedInputAllowance: number;
  readonly maxSpanMs: number;
  readonly partitionPolicyVersion: number;
};

const PartitionPolicy = z.strictObject({
  maxMembers: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  renderedInputAllowance: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  maxSpanMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  partitionPolicyVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export function parseMigrationPartitionPolicy(value: unknown): MigrationPartitionPolicy {
  return PartitionPolicy.parse(value);
}

export type MigrationOrderedSource = {
  readonly sourceId: string;
  readonly sessionId: string;
  readonly captureOrderValue: string;
  readonly captureOrderBasis: 'graph_tx_from' | 'archive_acceptance';
  readonly occurredAt: string;
  readonly createdAt: string;
};

/** Reserving a fixed cohort also fixes the policy used for every later seal in that cohort. */
export function rememberMigrationPolicy(
  db: SqliteHandle,
  cohortId: string,
  policy: MigrationPartitionPolicy,
): void {
  const json = JSON.stringify(
    PartitionPolicy.parse({
      maxMembers: policy.maxMembers,
      renderedInputAllowance: policy.renderedInputAllowance,
      maxSpanMs: policy.maxSpanMs,
      partitionPolicyVersion: policy.partitionPolicyVersion,
    }),
  );
  db.transaction(() => {
    if (readMigrationCohort(db, cohortId) === undefined) {
      throw new MigrationRefused(cohortId, 'migration_cohort_missing');
    }
    const row = db
      .prepare('SELECT partition_policy_json AS policy FROM migration_cohorts WHERE cohort_id = ?')
      .get(cohortId) as { policy: string | null };
    if (row.policy !== null && row.policy !== json) {
      throw new MigrationRefused(cohortId, 'the frozen narrative partition policy cannot change');
    }
    db.prepare('UPDATE migration_cohorts SET partition_policy_json = ? WHERE cohort_id = ?').run(
      json,
      cohortId,
    );
  }).immediate();
}

/** The policy is a writer record; an absent policy is not a live-source reservation. */
export function readMigrationPolicy(
  db: SqliteHandle,
  cohortId: string,
): MigrationPartitionPolicy | undefined {
  const row = db
    .prepare('SELECT partition_policy_json AS policy FROM migration_cohorts WHERE cohort_id = ?')
    .get(cohortId) as { policy: string | null } | undefined;
  return row?.policy === null || row?.policy === undefined
    ? undefined
    : PartitionPolicy.parse(JSON.parse(row.policy));
}

/** Saves the first proved order. Better later evidence never reorders a frozen partition. */
export function rememberMigrationOrder(
  db: SqliteHandle,
  input: {
    readonly cohortId: string;
    readonly sourceId: string;
    readonly value?: string;
    readonly basis?: 'graph_tx_from' | 'archive_acceptance';
    readonly gap?: string;
  },
): void {
  if (!db.inTransaction) {
    throw new Error('migration order requires its publication transaction');
  }
  const row = db
    .prepare(
      `SELECT m.status, m.capture_order_value, m.partition_assignment, s.verification_status
       FROM migration_progress m JOIN source_records s ON s.source_id = m.source_id
      WHERE m.cohort_id = ? AND m.source_id = ?`,
    )
    .get(input.cohortId, input.sourceId) as
    | {
        status: string;
        capture_order_value: string | null;
        partition_assignment: string | null;
        verification_status: string;
      }
    | undefined;
  if (row?.status !== 'verified' || row.verification_status !== 'verified') {
    throw new MigrationRefused(input.sourceId, 'migration order requires a verified frozen member');
  }
  if (row.capture_order_value !== null) {
    return;
  }
  if (row.partition_assignment !== null) {
    throw new MigrationRefused(input.sourceId, 'an assigned legacy member has no saved order');
  }
  if (input.value === undefined || input.basis === undefined) {
    if (input.gap === undefined) {
      throw new Error('missing migration order requires an explicit gap');
    }
    db.prepare(
      'UPDATE migration_progress SET partition_gap = ? WHERE cohort_id = ? AND source_id = ?',
    ).run(input.gap, input.cohortId, input.sourceId);
    return;
  }
  const parsed = IsoTimestampSchema.safeParse(input.value);
  if (!parsed.success) {
    throw new MigrationRefused(input.sourceId, 'migration order is not a recorded instant');
  }
  const instant = new Date(parsed.data);
  db.prepare(
    `UPDATE migration_progress SET capture_order_value = ?, capture_order_basis = ?, partition_gap = NULL
      WHERE cohort_id = ? AND source_id = ?`,
  ).run(instant.toISOString(), input.basis, input.cohortId, input.sourceId);
}

/** A source id breaks equal timestamps. Neither field belongs to the live ingest cursor. */
export function listMigrationRemainder(
  db: SqliteHandle,
  cohortId: string,
  sessionId: string,
  limit: number,
): readonly MigrationOrderedSource[] {
  const rows = db
    .prepare(
      `SELECT m.source_id, s.session_id, m.capture_order_value, m.capture_order_basis, s.occurred_at, s.created_at
       FROM migration_progress m JOIN source_records s ON s.source_id = m.source_id
      WHERE m.cohort_id = ? AND s.session_id = ? AND m.status = 'verified'
        AND s.verification_status = 'verified'
        AND m.partition_assignment IS NULL AND m.partition_gap IS NULL
        AND m.capture_order_value IS NOT NULL AND m.capture_order_basis IS NOT NULL
      ORDER BY m.capture_order_value, m.source_id LIMIT ?`,
    )
    .all(cohortId, sessionId, limit) as {
    source_id: string;
    session_id: string;
    capture_order_value: string;
    capture_order_basis: 'graph_tx_from' | 'archive_acceptance';
    occurred_at: string;
    created_at: string;
  }[];
  return rows.map((row) => ({
    sourceId: row.source_id,
    sessionId: row.session_id,
    captureOrderValue: row.capture_order_value,
    captureOrderBasis: row.capture_order_basis,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
  }));
}

/** Whether a live seal would steal an unassigned member from an explicitly reserved cohort. */
export function sourceReservedForMigration(db: SqliteHandle, sourceId: string): boolean {
  return (
    db
      .prepare(`SELECT 1 FROM (SELECT ? AS source_id) r WHERE ${RESERVED_MIGRATION_SOURCE}`)
      .get(sourceId) !== undefined
  );
}

/** Membership and its cohort assignment commit together; a crash cannot leave a half-assigned chunk. */
export function sealMigrationMembership(
  db: SqliteHandle,
  input: {
    readonly cohortId: string;
    readonly sessionId: string;
    readonly members: readonly MigrationOrderedSource[];
    readonly at: Date;
  },
): ChunkSealOutcome {
  const policy = readMigrationPolicy(db, input.cohortId);
  if (policy === undefined) {
    throw new MigrationRefused(input.cohortId, 'migration membership requires its frozen policy');
  }
  if (input.members.length > policy.maxMembers) {
    throw new MigrationRefused(
      input.sessionId,
      'migration membership exceeds its fixed member bound',
    );
  }
  return db
    .transaction(() => {
      for (const member of input.members) {
        const problem = migrationMemberProblem(db, {
          cohortId: input.cohortId,
          sourceId: member.sourceId,
          sessionId: input.sessionId,
          order: member.captureOrderValue,
          policyVersion: policy.partitionPolicyVersion,
        });
        if (problem !== undefined) {
          throw new MigrationRefused(member.sourceId, problem);
        }
      }
      const result = sealChunk(db, {
        sessionId: input.sessionId,
        sourceIds: input.members.map((row) => row.sourceId),
        sealedAt: input.at,
        partitionPolicyVersion: policy.partitionPolicyVersion,
        migrationCohortId: input.cohortId,
        expected: input.members.map((row) => ({
          sourceId: row.sourceId,
          captureOrderValue: row.captureOrderValue,
        })),
      });
      for (const member of input.members) {
        recordMigrationProgress(db, {
          cohortId: input.cohortId,
          sourceId: member.sourceId,
          status: 'verified',
          partitionAssignment: result.chunkId,
        });
      }
      return result;
    })
    .immediate();
}
