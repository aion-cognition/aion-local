import type { SqliteHandle } from './database.js';
import { allocateNarrativeRevision, type RevisionFamily } from './narrative-revisions.js';

/**
 * What a family's unpublished allocations are, and what a landed publication does to them.
 *
 * A revision number is spent the moment it is handed out, and an attempt that died before it
 * bound an operation left its row `allocated` for good: the scheduler kept nominating it, and the
 * retry that followed spent a second number beside it. Both halves are decided here — which row a
 * retry may take up again, and which rows a successful publication makes stale.
 *
 * Kept out of `narrative-revisions.ts` because that module is at the ceiling; nothing moved, so
 * every existing caller reads the same helper it always did.
 */

export type AllocatedRevision = {
  readonly revisionNo: number;
  readonly nodeId: string;
  readonly operationId: string | null;
  readonly attempts: number;
  readonly blockedReason: string | null;
};

/**
 * Every unpublished allocation of one family key, oldest first.
 *
 * `prepared` rows are here too: a caller deciding what it may take up needs to see the attempt
 * that is holding a number as well as the ones that are not.
 */
export function listAllocatedRevisions(
  db: SqliteHandle,
  family: RevisionFamily,
  familyKey: string,
): readonly AllocatedRevision[] {
  const rows = db
    .prepare(
      `SELECT revision_no, node_id, operation_id, attempts, blocked_reason
         FROM ${family.revisionTable}
        WHERE ${family.keyColumn} = ? AND state IN ('allocated', 'prepared')
        ORDER BY revision_no`,
    )
    .all(familyKey) as {
    revision_no: number;
    node_id: string;
    operation_id: string | null;
    attempts: number;
    blocked_reason: string | null;
  }[];
  return rows.map((row) => ({
    revisionNo: row.revision_no,
    nodeId: row.node_id,
    operationId: row.operation_id,
    attempts: row.attempts,
    blockedReason: row.blocked_reason,
  }));
}

/**
 * Closes the allocations this head transition actually invalidated.
 *
 * A number handed out BEFORE the one that just published was handed out while the old head stood:
 * whatever it was preparing rested on a predecessor, and the guard would refuse it. Leaving it
 * `allocated` leaves it runnable, and a scheduler reading durable state cannot tell it from work
 * that is genuinely owed.
 *
 * A LATER number is not this transition's business. It was handed out after this one, so it is
 * either targeting the head this publication just wrote or it will be refused on its own head
 * fence — and closing it is how a slow caller returning from an already-acknowledged publication
 * takes a live attempt down with it, wedging the shared slot. Revision numbers are monotone per
 * family, so `<` is exactly "handed out earlier".
 *
 * Only `allocated` rows are closed. A `prepared` row is bound to an operation the coordinator is
 * still resolving, and abandoning that would take a number out from under an attempt in flight.
 *
 * Call it inside the acknowledgment's own transaction. Run from an application caller after the
 * publication returns, it acts at a moment that has nothing to do with the transition it names.
 */
export function abandonStaleAllocations(
  db: SqliteHandle,
  family: RevisionFamily,
  familyKey: string,
  publishedRevisionNo: number,
  closedAt: Date,
): number {
  return db
    .prepare(
      `UPDATE ${family.revisionTable} SET state = 'abandoned', closed_at = ?
        WHERE ${family.keyColumn} = ? AND revision_no < ? AND state = 'allocated'`,
    )
    .run(closedAt.toISOString(), familyKey, publishedRevisionNo).changes;
}

export type RevisionClaim = {
  readonly revisionNo: number;
  readonly nodeId: string;
  /** False when the claim took up a number an earlier attempt had already been handed. */
  readonly allocated: boolean;
};

export type ClaimRequest = {
  readonly familyKey: string;
  /**
   * The operation identity a revision of this family publishes under, without its number: the
   * claim appends the revision number. One identity per (family key, number) is what makes
   * "does a durable intent exist for this attempt" an exact question rather than a guess.
   */
  readonly operationPrefix: string;
  readonly now: Date;
  /**
   * When this claim's hold on the number lapses.
   *
   * It is written to `claim_expires_at` and nowhere else: `next_attempt_at` is the scheduler's
   * retry date, read by the nomination that decides which chunks a run may try at all, and a lease
   * written there says the whole chunk is not due yet — which stalls a reconsidered block for the
   * length of a lease nobody is holding.
   *
   * Lapsing frees the WORK, never the number. See `spendExpiredClaims`.
   */
  readonly leaseUntil: Date;
};

/**
 * Retires the numbers whose claim lapsed, so no second actor can ever run under the first's name.
 *
 * An expired lease says the deadline passed. It does not say the actor stopped: a stalled process
 * holding this number can still return with an output. So the number is SPENT rather than handed
 * on. Reusing it made the operation identity — derived from the family key and the number — the
 * same string for two actors, and everything downstream that identity is supposed to separate then
 * ran together: the returning actor's release cleared the newer actor's binding, and its output
 * collided with the newer publication on one durable identity.
 *
 * A number is only ever taken up again by a release, which is an actor saying it finished without
 * binding an intent. That is the one case where nobody else is running under the name.
 *
 * A row carrying a durable intent is left alone whatever its lease says. That attempt belongs to
 * the coordinator's own recovery, and retiring it would take the number out from under it.
 */
function spendExpiredClaims(
  db: SqliteHandle,
  family: RevisionFamily,
  familyKey: string,
  now: Date,
): number {
  return db
    .prepare(
      `UPDATE ${family.revisionTable}
          SET state = 'abandoned', closed_at = ?, last_failure_reason = 'claim_expired'
        WHERE ${family.keyColumn} = ? AND state = 'allocated'
          AND operation_id IS NOT NULL
          AND claim_expires_at IS NOT NULL AND claim_expires_at <= ?
          AND NOT EXISTS (
            SELECT 1 FROM publication_intents i
             WHERE i.operation_id = ${family.revisionTable}.operation_id)`,
    )
    .run(now.toISOString(), familyKey, now.toISOString()).changes;
}

/**
 * Takes ownership of a revision number for one attempt, atomically, before any asynchronous work.
 *
 * Reusing a number because no publication record exists yet is not ownership: two callers read
 * the same absence and both proceed, and their two valid outputs then collide on one operation
 * identity. The claim is a write, in one immediate transaction, and what it writes is the binding
 * and the lease together.
 *
 * A row is claimable when it is unblocked, DUE by the scheduler's own retry date, UNCLAIMED, and
 * carries no durable intent for the identity its number implies. Unclaimed means never claimed or
 * given back by the actor that held it; a lapsed lease does not qualify, because expiry proves a
 * deadline passed and not that anyone stopped. Those are retired first, so the run that finds
 * nothing free spends a new number rather than a name somebody may still be using.
 */
export function claimNarrativeRevision(
  db: SqliteHandle,
  family: RevisionFamily,
  request: ClaimRequest,
): RevisionClaim {
  return db
    .transaction((): RevisionClaim => {
      spendExpiredClaims(db, family, request.familyKey, request.now);
      const due = db
        .prepare(
          `SELECT revision_no, node_id FROM ${family.revisionTable}
            WHERE ${family.keyColumn} = ? AND state = 'allocated' AND blocked_reason IS NULL
              AND operation_id IS NULL AND claim_expires_at IS NULL
              AND COALESCE(next_attempt_at, allocated_at) <= ?
              AND NOT EXISTS (
                SELECT 1 FROM publication_intents i
                 WHERE i.operation_id = ? || CAST(revision_no AS TEXT))
            ORDER BY COALESCE(next_attempt_at, allocated_at), revision_no
            LIMIT 1`,
        )
        .get(request.familyKey, request.now.toISOString(), request.operationPrefix) as
        { revision_no: number; node_id: string } | undefined;
      const claimed =
        due ??
        (() => {
          const fresh = allocateNarrativeRevision(db, family, request.familyKey, request.now);
          return { revision_no: fresh.revisionNo, node_id: fresh.nodeId };
        })();
      db.prepare(
        `UPDATE ${family.revisionTable}
            SET operation_id = ? || CAST(revision_no AS TEXT), claim_expires_at = ?
          WHERE ${family.keyColumn} = ? AND revision_no = ? AND state = 'allocated'`,
      ).run(
        request.operationPrefix,
        request.leaseUntil.toISOString(),
        request.familyKey,
        claimed.revision_no,
      );
      return {
        revisionNo: claimed.revision_no,
        nodeId: claimed.node_id,
        allocated: due === undefined,
      };
    })
    .immediate();
}

/**
 * Gives a claimed number back, so the next attempt takes it up rather than spending another.
 *
 * Only from `allocated`, only when no durable intent was ever opened for it — a number an operation
 * is holding is not the caller's to release, and the coordinator's own recovery settles that one —
 * and only under the binding the caller is actually holding. The ownership test is the whole point
 * of the identity: a release names the claim it is giving back, and a row carrying a different
 * binding belongs to somebody else's attempt.
 */
export function releaseNarrativeClaim(
  db: SqliteHandle,
  family: RevisionFamily,
  request: {
    readonly familyKey: string;
    readonly revisionNo: number;
    readonly operationId: string;
  },
): boolean {
  const held = db
    .prepare('SELECT 1 AS found FROM publication_intents WHERE operation_id = ?')
    .get(request.operationId);
  if (held !== undefined) {
    return false;
  }
  return (
    db
      .prepare(
        `UPDATE ${family.revisionTable} SET operation_id = NULL, claim_expires_at = NULL
          WHERE ${family.keyColumn} = ? AND revision_no = ? AND state = 'allocated'
            AND operation_id = ?`,
      )
      .run(request.familyKey, request.revisionNo, request.operationId).changes === 1
  );
}

/**
 * The bounds an attempt ran under, recorded with the outcome that refused it.
 *
 * A block on a bound clears when the bound changes and on nothing else, so a detector comparing
 * the policy in force against the one that refused needs the second number as well as the first.
 * Without it the refusal is a dead end: nobody can tell a block that a new allowance would clear
 * from one it would not.
 */
export function recordAttemptPolicy(
  db: SqliteHandle,
  family: RevisionFamily,
  familyKey: string,
  revisionNo: number,
  policy: Record<string, number>,
): boolean {
  return (
    db
      .prepare(
        `UPDATE ${family.revisionTable} SET attempt_policy_json = ?
          WHERE ${family.keyColumn} = ? AND revision_no = ?`,
      )
      .run(JSON.stringify(policy), familyKey, revisionNo).changes === 1
  );
}

export function readAttemptPolicy(
  db: SqliteHandle,
  family: RevisionFamily,
  familyKey: string,
  revisionNo: number,
): Record<string, number> | undefined {
  const row = db
    .prepare(
      `SELECT attempt_policy_json FROM ${family.revisionTable}
        WHERE ${family.keyColumn} = ? AND revision_no = ?`,
    )
    .get(familyKey, revisionNo) as { attempt_policy_json: string | null } | undefined;
  return row?.attempt_policy_json == null
    ? undefined
    : (JSON.parse(row.attempt_policy_json) as Record<string, number>);
}
