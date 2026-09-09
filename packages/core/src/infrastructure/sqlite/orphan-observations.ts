import { createHash } from 'node:crypto';

import type { SqliteHandle } from './database.js';

/**
 * How long a node has been continuously certified as holding nothing up.
 *
 * The clock starts when the whole unsupported predicate certifies, not when a partial read first
 * missed the support, and it goes back to zero whenever any scope the certification rested on
 * moves. A node's creation date is not its orphan age: a memory nobody has looked at since it was
 * written has been unobserved for months, not unsupported for months, and forgetting it on that
 * reading is a suppression with no reopen path.
 */
export type OrphanDisposition = 'unsupported' | 'supported' | 'unknown';

export type OrphanObservation = {
  readonly nodeId: string;
  readonly firstVerifiedAt: string;
  readonly evidenceRevision: Readonly<Record<string, string>>;
  readonly policyRevision: number;
  readonly disposition: OrphanDisposition;
  readonly reason: string | null;
};

type ObservationRow = {
  node_id: string;
  first_verified_at: string;
  evidence_revision_json: string;
  policy_revision: number;
  disposition: OrphanDisposition;
  reason: string | null;
};

function toObservation(row: ObservationRow): OrphanObservation {
  return {
    nodeId: row.node_id,
    firstVerifiedAt: row.first_verified_at,
    evidenceRevision: JSON.parse(row.evidence_revision_json) as Record<string, string>,
    policyRevision: row.policy_revision,
    disposition: row.disposition,
    reason: row.reason,
  };
}

export function readOrphanObservation(
  db: SqliteHandle,
  nodeId: string,
): OrphanObservation | undefined {
  const row = db
    .prepare(
      `SELECT node_id, first_verified_at, evidence_revision_json, policy_revision, disposition,
              reason
       FROM orphan_observations WHERE node_id = ?`,
    )
    .get(nodeId) as ObservationRow | undefined;
  return row === undefined ? undefined : toObservation(row);
}

/** One comparable value for everything a certification rested on. */
function revisionDigest(evidenceRevision: Readonly<Record<string, string>>): string {
  const entries = Object.entries(evidenceRevision).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

export type OrphanQualification = {
  readonly nodeId: string;
  readonly evidenceRevision: Readonly<Record<string, string>>;
  readonly policyRevision: number;
  readonly disposition: OrphanDisposition;
  readonly reason: string;
  readonly now: Date;
};

/**
 * Records what this scan certified, and answers with the qualification as it now stands.
 *
 * A first certification starts the clock. A repeat certification against the same scopes leaves
 * it where it is, which is what makes the age mean continuous qualification. Any change to those
 * scopes restarts it, even where the new reading says the same thing: the interval between the
 * two readings is unaccounted for, and a node can gain and lose support inside it.
 *
 * A node that certifies as supported or as unknown keeps a row saying so with the clock reset,
 * so the next scan reads a qualification of zero rather than an absent record it might mistake
 * for a node nobody has checked.
 */
export function recordOrphanQualification(
  db: SqliteHandle,
  qualification: OrphanQualification,
): OrphanObservation {
  return db
    .transaction((): OrphanObservation => {
      const held = readOrphanObservation(db, qualification.nodeId);
      const digest = revisionDigest(qualification.evidenceRevision);
      const carried =
        held?.disposition === qualification.disposition &&
        revisionDigest(held.evidenceRevision) === digest
          ? held.firstVerifiedAt
          : undefined;
      const firstVerifiedAt = carried ?? qualification.now.toISOString();
      db.prepare(
        `INSERT INTO orphan_observations
           (node_id, first_verified_at, evidence_revision_json, policy_revision, disposition,
            reason, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (node_id) DO UPDATE SET
           first_verified_at = excluded.first_verified_at,
           evidence_revision_json = excluded.evidence_revision_json,
           policy_revision = excluded.policy_revision,
           disposition = excluded.disposition,
           reason = excluded.reason,
           updated_at = excluded.updated_at`,
      ).run(
        qualification.nodeId,
        firstVerifiedAt,
        JSON.stringify(qualification.evidenceRevision),
        qualification.policyRevision,
        qualification.disposition,
        qualification.reason,
        qualification.now.toISOString(),
      );
      return {
        nodeId: qualification.nodeId,
        firstVerifiedAt,
        evidenceRevision: qualification.evidenceRevision,
        policyRevision: qualification.policyRevision,
        disposition: qualification.disposition,
        reason: qualification.reason,
      };
    })
    .immediate();
}

/** Drops a node's qualification outright, for a node that has left the population. */
export function clearOrphanQualification(db: SqliteHandle, nodeId: string): void {
  db.prepare('DELETE FROM orphan_observations WHERE node_id = ?').run(nodeId);
}
