import type { SqliteHandle } from './database.js';
import type { RevisionFamily } from './narrative-revisions.js';

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
 * Closes every OTHER unpublished allocation of this family once one of them published.
 *
 * A number allocated against a head that has since moved describes an attempt nobody can finish:
 * its output was prepared against a predecessor, and the guard would refuse it. Leaving it
 * `allocated` leaves it runnable, and a scheduler reading durable state cannot tell it from work
 * that is genuinely owed.
 *
 * Only `allocated` rows are closed. A `prepared` row is bound to an operation the coordinator is
 * still resolving, and abandoning that would take a number out from under an attempt in flight.
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
        WHERE ${family.keyColumn} = ? AND revision_no <> ? AND state = 'allocated'`,
    )
    .run(closedAt.toISOString(), familyKey, publishedRevisionNo).changes;
}
