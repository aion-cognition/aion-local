import type { SqliteHandle } from './database.js';
import type { RevisionFamily } from './narrative-revisions.js';

/**
 * A refused attempt's block: what it recorded, and how it is cleared.
 *
 * A block is not a delay. It records that a prerequisite did not hold, and it clears when that
 * prerequisite moves and on nothing else — so what the refusal knew has to survive it, which is
 * what the context here is for.
 */

/**
 * What the refused attempt knew, recorded beside the reason it recorded.
 *
 * The reason names a class and the records have to name the cause, and some of what a cause needs
 * is not recoverable afterwards. `at` is the moment of the READ that refused, which is not the
 * moment the number was allocated: a reused allocation is older than the reading, and asking the
 * source states about the wrong moment finds a forget that was over before the attempt began.
 * `uncountedScopes` is the exact set the refusal could not count, members and external requirement
 * sources alike, so the wakeup asks about the set that blocked it rather than about the members it
 * happens to know.
 *
 * `suppressedMembers` is what the refusal actually READ as suppressed. Re-deriving that afterwards
 * from the state records means comparing timestamps, and a forget, a refusal and a restore inside
 * the same instant order by nothing a comparison can see. What the attempt saw is not recoverable;
 * it is only recordable.
 */
export type RevisionBlockContext = {
  readonly at: string;
  readonly uncountedScopes?: readonly { readonly sourceId: string; readonly scope: string }[];
  readonly suppressedMembers?: readonly string[];
};

export function blockRevisionAttempt(
  db: SqliteHandle,
  family: RevisionFamily,
  familyKey: string,
  revisionNo: number,
  reason: string,
  context?: RevisionBlockContext,
): boolean {
  const result = db
    .prepare(
      `UPDATE ${family.revisionTable} SET blocked_reason = ?, blocked_context_json = ?
       WHERE ${family.keyColumn} = ? AND revision_no = ? AND state = 'allocated'`,
    )
    .run(reason, context === undefined ? null : JSON.stringify(context), familyKey, revisionNo);
  return result.changes === 1;
}

export function readBlockContext(
  db: SqliteHandle,
  family: RevisionFamily,
  familyKey: string,
  revisionNo: number,
): RevisionBlockContext | undefined {
  const row = db
    .prepare(
      `SELECT blocked_context_json FROM ${family.revisionTable}
        WHERE ${family.keyColumn} = ? AND revision_no = ?`,
    )
    .get(familyKey, revisionNo) as { blocked_context_json: string | null } | undefined;
  if (row?.blocked_context_json == null) {
    return undefined;
  }
  try {
    return JSON.parse(row.blocked_context_json) as RevisionBlockContext;
  } catch {
    return undefined;
  }
}

export function clearRevisionBlock(
  db: SqliteHandle,
  family: RevisionFamily,
  familyKey: string,
  revisionNo: number,
): boolean {
  const result = db
    .prepare(
      `UPDATE ${family.revisionTable} SET blocked_reason = NULL, blocked_context_json = NULL
       WHERE ${family.keyColumn} = ? AND revision_no = ? AND blocked_reason IS NOT NULL`,
    )
    .run(familyKey, revisionNo);
  return result.changes === 1;
}
