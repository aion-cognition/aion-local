import type { SqliteHandle } from './database.js';

/**
 * What readiness requires, at the revision it required it. A revision is immutable once
 * anything has been processed under it, so a proof made under the old one still says what it
 * was measured against.
 */
export type ReadinessPolicy = {
  readonly policyRevision: number;
  readonly pipelineVersion: string;
  readonly stageNames: readonly string[];
};

export type ReadinessPolicyInput = ReadinessPolicy & {
  readonly contractDigest: string;
  readonly transferCapabilities: readonly string[];
  readonly createdAt: Date;
};

/** The policy in force: the highest revision published. Absent until one has been. */
export function readCurrentReadinessPolicy(db: SqliteHandle): ReadinessPolicy | undefined {
  const row = db
    .prepare(
      `SELECT policy_revision, pipeline_version, stages_json FROM readiness_policies
       ORDER BY policy_revision DESC LIMIT 1`,
    )
    .get() as
    { policy_revision: number; pipeline_version: string; stages_json: string } | undefined;
  if (row === undefined) {
    return undefined;
  }
  return {
    policyRevision: row.policy_revision,
    pipelineVersion: row.pipeline_version,
    stageNames: JSON.parse(row.stages_json) as string[],
  };
}

/**
 * Publishes a revision, or leaves the one already published alone. Re-running a bootstrap under
 * the same revision writes nothing, because a revision anything has processed under cannot
 * change what it required.
 */
export function recordReadinessPolicy(db: SqliteHandle, policy: ReadinessPolicyInput): void {
  db.prepare(
    `INSERT INTO readiness_policies
       (policy_revision, contract_digest, pipeline_version, stages_json,
        transfer_capabilities_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (policy_revision) DO NOTHING`,
  ).run(
    policy.policyRevision,
    policy.contractDigest,
    policy.pipelineVersion,
    JSON.stringify([...policy.stageNames]),
    JSON.stringify([...policy.transferCapabilities]),
    policy.createdAt.toISOString(),
  );
}
