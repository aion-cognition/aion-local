import type { RollupMemberCursor } from '../../infrastructure/graph/narrative-rollup-queries.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { getLedgerEntry, markLedgerApplied } from '../../infrastructure/sqlite/ops-ledger.js';
import type { RollupMember, RollupScope, RollupWindow } from '../domain/rollup.js';

/**
 * Where a scope's member enumeration stopped, and where the next page starts.
 *
 * Split out of the pass because it answers one question and the pass answers another: this is a
 * position in an enumeration, and every rule in it is about pages and window boundaries rather
 * than about what a window then does.
 */

/** Where the last pass of one scope stopped reading members. */
function memberCursorKey(scope: RollupScope): string {
  return `narrative-rollup:member-cursor:${scope}`;
}

export function readMemberCursor(
  db: SqliteHandle | undefined,
  scope: RollupScope,
): RollupMemberCursor | undefined {
  if (db === undefined) {
    return undefined;
  }
  const summary = getLedgerEntry(db, memberCursorKey(scope))?.summary;
  if (typeof summary !== 'object' || summary === null) {
    return undefined;
  }
  // The empty member half is the whole-window boundary this file's own writer emits, not a
  // malformed key: past a calendar window there is no member to name. Refusing it started every
  // later run at the front of the enumeration, so a window larger than one page hid the fitting
  // windows behind it for ever.
  const { occurredAt, id } = summary as { occurredAt?: unknown; id?: unknown };
  if (typeof occurredAt !== 'string' || typeof id !== 'string') {
    return undefined;
  }
  const at = new Date(occurredAt);
  return Number.isNaN(at.getTime()) ? undefined : { occurredAt: at, id };
}

export function writeMemberCursor(
  db: SqliteHandle | undefined,
  scope: RollupScope,
  cursor: RollupMemberCursor | undefined,
): void {
  if (db === undefined) {
    return;
  }
  markLedgerApplied(
    db,
    memberCursorKey(scope),
    cursor === undefined ? {} : { occurredAt: cursor.occurredAt.toISOString(), id: cursor.id },
  );
}

/**
 * Where the next page starts, which is only ever a WINDOW boundary.
 *
 * Three positions, and the reason for each. A short page reached the end of the enumeration and
 * clears the position. A full page that proved at least one window whole stops at the last member
 * of the last whole one, so the cut window is read again from its own beginning with a fresh page
 * to itself. A full page that proved NONE whole holds a single window larger than the page: it can
 * never be enumerated at this bound, so the position steps past the window's calendar end, and the
 * window stays blocked instead of publishing the part of it that fit.
 *
 * A cursor that stopped at the last MEMBER read is the defect this replaces. It leaves a position
 * inside a window, and the run that comes back to it sees a suffix and calls it a complete window.
 */
export function nextMemberCursor(
  members: readonly RollupMember[],
  memberLimit: number,
  paged: { readonly whole: readonly RollupWindow[]; readonly cut: RollupWindow | undefined },
): RollupMemberCursor | undefined {
  if (members.length < memberLimit) {
    return undefined;
  }
  const lastWhole = paged.whole[paged.whole.length - 1];
  if (lastWhole !== undefined) {
    const stopAt = lastWhole.members[lastWhole.members.length - 1];
    return stopAt?.occurredAt === undefined
      ? undefined
      : { occurredAt: stopAt.occurredAt, id: stopAt.id };
  }
  if (paged.cut !== undefined) {
    // The window's own exclusive end. Nothing inside it sorts at or after this, and a member
    // occurring exactly at it belongs to the next window and is reached by the id half of the key.
    return { occurredAt: paged.cut.end, id: '' };
  }
  // A full page of members none of which could be placed in a window at all.
  const last = members[members.length - 1];
  return last?.occurredAt === undefined ? undefined : { occurredAt: last.occurredAt, id: last.id };
}
