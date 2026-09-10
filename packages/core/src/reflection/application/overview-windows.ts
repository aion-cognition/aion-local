import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { getLedgerEntry, markLedgerApplied } from '../../infrastructure/sqlite/ops-ledger.js';
import {
  publishedChunkSpans,
  publishedOverviewSpans,
  unplaceableChunks,
  type MemberCursor,
  type OverviewMember,
} from '../../infrastructure/sqlite/overview-membership.js';
import { isWindowClosed, pagedWindows, rollupWindow, type RollupScope } from '../domain/rollup.js';

/** Members read per run, across every window. The bound on the scan, not on the attempts. */
export const OVERVIEW_MEMBER_SCAN_LIMIT = 500;

/** Pages one whole-window re-read may walk before it gives up proving completeness. */
const WINDOW_PAGE_LIMIT = 8;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Which windows a run may act on, and where the next run picks up.
 *
 * Split out of the pass itself because it answers one question and the pass answers another: this
 * decides what a bounded page of members PROVED, and the pass decides what to do about it. Both
 * halves grew, and the file they shared reached its ceiling.
 */

export type Window = {
  readonly key: string;
  readonly start: Date;
  readonly end: Date;
  readonly members: readonly OverviewMember[];
};

/** Every member of the scope below, grouped into the closed windows of this scope. */
function readMembers(
  db: SqliteHandle,
  scope: RollupScope,
  after?: MemberCursor,
): readonly OverviewMember[] {
  return scope === 'day'
    ? publishedChunkSpans(db, OVERVIEW_MEMBER_SCAN_LIMIT, after)
    : publishedOverviewSpans(db, 'day', OVERVIEW_MEMBER_SCAN_LIMIT, after);
}

export function closedWindows(
  db: SqliteHandle,
  scope: RollupScope,
  now: Date,
): {
  readonly windows: readonly Window[];
  readonly unplaceable: number;
  readonly next: MemberCursor | undefined;
} {
  const cursor = readMemberCursor(db, scope);
  let members = readMembers(db, scope, cursor);
  if (members.length === 0 && cursor !== undefined) {
    // The end of the enumeration, reached inside this run. Starting from the front again is what
    // makes the position a position rather than a discharge.
    members = readMembers(db, scope);
  }
  const grouped = new Map<
    string,
    { bounds: ReturnType<typeof rollupWindow>; rows: OverviewMember[] }
  >();
  for (const member of members) {
    const at = new Date(member.spanEnd);
    if (Number.isNaN(at.getTime())) {
      continue;
    }
    const bounds = rollupWindow(scope, at);
    const entry = grouped.get(bounds.key);
    if (entry === undefined) {
      grouped.set(bounds.key, { bounds, rows: [member] });
      continue;
    }
    entry.rows.push(member);
  }
  const all = [...grouped.values()]
    .map((entry) => ({
      key: entry.bounds.key,
      start: entry.bounds.start,
      end: entry.bounds.end,
      members: [...entry.rows].sort((left, right) => left.spanEnd.localeCompare(right.spanEnd)),
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
  // A full page may have stopped in the middle of its newest window, and an overview asserts it
  // saw the whole of what it covers. That window is not offered for publication at all, and the
  // position never rests inside it: the next page either reads it whole from its own beginning, or
  // — when one window filled the page by itself and never can be read whole at this bound — steps
  // past its calendar end so the windows behind it are reached.
  const paged = pagedWindows(all, members.length >= OVERVIEW_MEMBER_SCAN_LIMIT);
  const windows = paged.whole.filter((window) => isWindowClosed(window, now));
  return {
    windows,
    unplaceable: scope === 'day' ? unplaceableChunks(db) : 0,
    next: nextMemberCursor(members, paged),
  };
}

/** Where the next page starts, which is only ever a window boundary. */
function nextMemberCursor(
  members: readonly OverviewMember[],
  paged: { readonly whole: readonly Window[]; readonly cut: Window | undefined },
): MemberCursor | undefined {
  if (members.length < OVERVIEW_MEMBER_SCAN_LIMIT) {
    return undefined;
  }
  const lastWhole = paged.whole[paged.whole.length - 1];
  if (lastWhole !== undefined) {
    const stopAt = lastWhole.members[lastWhole.members.length - 1];
    return stopAt === undefined
      ? undefined
      : { spanEnd: stopAt.spanEnd, familyKey: stopAt.familyKey };
  }
  if (paged.cut !== undefined) {
    return { spanEnd: paged.cut.end.toISOString(), familyKey: '' };
  }
  const last = members[members.length - 1];
  return last === undefined ? undefined : { spanEnd: last.spanEnd, familyKey: last.familyKey };
}

/** Where the last pass of one scope stopped reading members. */
function memberCursorKey(scope: RollupScope): string {
  return `narrative-overview:member-cursor:${scope}`;
}

function readMemberCursor(db: SqliteHandle, scope: RollupScope): MemberCursor | undefined {
  const summary = getLedgerEntry(db, memberCursorKey(scope))?.summary;
  if (typeof summary !== 'object' || summary === null) {
    return undefined;
  }
  const { spanEnd, familyKey } = summary as { spanEnd?: unknown; familyKey?: unknown };
  return typeof spanEnd === 'string' && typeof familyKey === 'string' && familyKey !== ''
    ? { spanEnd, familyKey }
    : undefined;
}

export function writeMemberCursor(
  db: SqliteHandle,
  scope: RollupScope,
  cursor: MemberCursor | undefined,
): void {
  markLedgerApplied(db, memberCursorKey(scope), cursor === undefined ? {} : { ...cursor });
}

/**
 * The WHOLE of one window's membership, re-read from the records.
 *
 * The fence an overview needs is not "is each member I chose still current": a chunk that arrives
 * in a closed window while the window is being written changes nothing about the members already
 * chosen, and a check that only walks the chosen list publishes a subset while claiming to cover
 * the window whole. So the set is re-derived and compared as a set.
 *
 * Reading starts just before the window rather than at the front of the enumeration, and it gives
 * up rather than guessing: `undefined` means the bound was reached before the window was passed,
 * which is a completeness nobody proved and a publication that has to wait.
 */
export function windowMembers(
  db: SqliteHandle,
  scope: RollupScope,
  window: { readonly key: string; readonly start: Date },
): readonly OverviewMember[] | undefined {
  const held: OverviewMember[] = [];
  let cursor: MemberCursor | undefined = seedCursor(scope, window.start);
  for (let page = 0; page < WINDOW_PAGE_LIMIT; page += 1) {
    const rows = readMembers(db, scope, cursor);
    for (const member of rows) {
      const at = new Date(member.spanEnd);
      if (Number.isNaN(at.getTime())) {
        continue;
      }
      const { key } = rollupWindow(scope, at);
      if (key === window.key) {
        held.push(member);
      } else if (key > window.key) {
        // Past the window in the read's own order, so the set is complete.
        return held;
      }
    }
    if (rows.length < OVERVIEW_MEMBER_SCAN_LIMIT) {
      return held;
    }
    const last = rows[rows.length - 1];
    if (last === undefined) {
      return held;
    }
    cursor = { spanEnd: last.spanEnd, familyKey: last.familyKey };
  }
  return undefined;
}

/**
 * Where to start reading for one window, so a late window costs a page rather than the archive.
 *
 * A day's members are chunks ordered by span end, so the window's own start is the position. A
 * week's members are day overviews ordered by family key, so the position is the key of the day
 * before it — the read resumes strictly after the cursor, and the first day of the week must not
 * be the one it skips.
 */
function seedCursor(scope: RollupScope, start: Date): MemberCursor {
  if (scope === 'day') {
    return { spanEnd: start.toISOString(), familyKey: '' };
  }
  const before = new Date(start.getTime() - DAY_MS).toISOString().slice(0, 10);
  return { spanEnd: '', familyKey: `day:${before}` };
}
