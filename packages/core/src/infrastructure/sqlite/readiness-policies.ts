import { createHash } from 'node:crypto';

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

export type ReadinessContract = {
  readonly pipelineVersion: string;
  /** Every stage the pass requires, in the order the production pipeline runs them. */
  readonly stageNames: readonly string[];
  /** Runners a transferred obligation may name. An unlisted runner pins its source. */
  readonly transferCapabilities: readonly string[];
};

/** What the revision is keyed on. Two publications of the same contract are one revision. */
export function readinessContractDigest(contract: ReadinessContract): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        contract.pipelineVersion,
        [...contract.stageNames],
        [...contract.transferCapabilities].slice().sort(),
      ]),
    )
    .digest('hex');
}

/**
 * Publishes what readiness requires, and returns the revision in force afterwards.
 *
 * A contract already published takes no new revision, so restarting the service does not spend a
 * number or move what a source in flight is measured against. A changed contract takes the next
 * one and leaves every earlier revision exactly as it was: a source keeps the policy revision it
 * was accepted under, and a pipeline that gained a stage does not reopen a pass that finished.
 */
export function publishReadinessPolicy(
  db: SqliteHandle,
  contract: ReadinessContract,
  createdAt: Date,
): number {
  const contractDigest = readinessContractDigest(contract);
  return db
    .transaction((): number => {
      const held = db
        .prepare('SELECT policy_revision FROM readiness_policies WHERE contract_digest = ?')
        .get(contractDigest) as { policy_revision: number } | undefined;
      if (held !== undefined) {
        return held.policy_revision;
      }
      const high = db
        .prepare('SELECT COALESCE(MAX(policy_revision), 0) AS n FROM readiness_policies')
        .get() as { n: number };
      const policyRevision = high.n + 1;
      recordReadinessPolicy(db, {
        policyRevision,
        contractDigest,
        pipelineVersion: contract.pipelineVersion,
        stageNames: contract.stageNames,
        transferCapabilities: contract.transferCapabilities,
        createdAt,
      });
      return policyRevision;
    })
    .immediate();
}
