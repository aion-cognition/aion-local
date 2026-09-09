import { createHash } from 'node:crypto';

import type { SqliteHandle } from './database.js';

/**
 * What readiness requires, at the revision it required it. A revision is immutable once
 * anything has been processed under it, so a proof made under the old one still says what it
 * was measured against.
 *
 * Which revision is CURRENT is a separate question from which is newest. Publishing a contract
 * that was published before returns its own revision, and selection follows: a definition
 * cannot be re-issued under a higher number without becoming a different definition.
 */
export type ReadinessPolicy = {
  readonly policyRevision: number;
  readonly pipelineVersion: string;
  readonly stageNames: readonly string[];
};

export type ReadinessPolicyInput = ReadinessPolicy & {
  readonly contractDigest: string;
  readonly stageOptions?: StageOptions;
  readonly transferCapabilities: readonly string[];
  readonly createdAt: Date;
};

/** The policy in force: the one most recently selected, which is not always the highest. */
export function readCurrentReadinessPolicy(db: SqliteHandle): ReadinessPolicy | undefined {
  const row = db
    .prepare(
      `SELECT policy_revision, pipeline_version, stages_json FROM readiness_policies
       ORDER BY selection_seq DESC, policy_revision DESC LIMIT 1`,
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
       (policy_revision, contract_digest, pipeline_version, stages_json, stage_options_json,
        transfer_capabilities_json, selection_seq, created_at)
     VALUES (?, ?, ?, ?, ?, ?,
             (SELECT COALESCE(MAX(selection_seq), 0) + 1 FROM readiness_policies), ?)
     ON CONFLICT (policy_revision) DO NOTHING`,
  ).run(
    policy.policyRevision,
    policy.contractDigest,
    policy.pipelineVersion,
    JSON.stringify([...policy.stageNames]),
    policy.stageOptions === undefined ? null : canonicalText(policy.stageOptions),
    JSON.stringify([...policy.transferCapabilities]),
    policy.createdAt.toISOString(),
  );
}

/** What one stage runs on, by stage name. A stage taking none records an empty record. */
export type StageOptions = Readonly<Record<string, unknown>>;

export type ReadinessContract = {
  readonly pipelineVersion: string;
  /** Every stage the pass requires, in the order the production pipeline runs them. */
  readonly stageNames: readonly string[];
  /**
   * The options each named stage was constructed with.
   *
   * Part of identity, not decoration: a build that raised a stage's minimum input requires
   * something different of a source than the build before it did, and a contract that recorded
   * only the names would call the two the same pass.
   */
  readonly stageOptions?: Readonly<Record<string, StageOptions>>;
  /** Runners a transferred obligation may name. An unlisted runner pins its source. */
  readonly transferCapabilities: readonly string[];
};

/**
 * JSON with object keys in sorted order, so the digest is about what the options are rather
 * than about the order a build happened to construct them in.
 */
function canonicalText(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalText).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, held]) => held !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([key, held]) => `${JSON.stringify(key)}:${canonicalText(held)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** What the revision is keyed on. Two publications of the same contract are one revision. */
export function readinessContractDigest(contract: ReadinessContract): string {
  const options = contract.stageOptions ?? {};
  return createHash('sha256')
    .update(
      JSON.stringify([
        contract.pipelineVersion,
        [...contract.stageNames],
        [...contract.transferCapabilities].slice().sort(),
        contract.stageNames.map((name) => canonicalText(options[name] ?? {})),
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
 *
 * Whatever it returns is also what it selects. A build that goes back to a contract it published
 * two revisions ago gets that revision back AND makes it current, because the alternative leaves
 * the caller running one policy while every later read answers with another.
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
        selectReadinessPolicy(db, held.policy_revision);
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
        ...(contract.stageOptions === undefined ? {} : { stageOptions: stageOptionsOf(contract) }),
        transferCapabilities: contract.transferCapabilities,
        createdAt,
      });
      return policyRevision;
    })
    .immediate();
}

function stageOptionsOf(contract: ReadinessContract): StageOptions {
  const options = contract.stageOptions ?? {};
  return Object.fromEntries(contract.stageNames.map((name) => [name, options[name] ?? {}]));
}

/**
 * Makes one published definition current, spending a selection number only when it is not
 * already the one in force. A restart under an unchanged contract therefore writes nothing.
 */
function selectReadinessPolicy(db: SqliteHandle, policyRevision: number): void {
  if (readCurrentReadinessPolicy(db)?.policyRevision === policyRevision) {
    return;
  }
  db.prepare(
    `UPDATE readiness_policies
       SET selection_seq = (SELECT COALESCE(MAX(selection_seq), 0) + 1 FROM readiness_policies)
     WHERE policy_revision = ?`,
  ).run(policyRevision);
}
