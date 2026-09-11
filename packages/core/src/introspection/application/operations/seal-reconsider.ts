import {
  blockedAttempts,
  type BlockedAttempt,
} from '../../../infrastructure/sqlite/chunk-nomination.js';
import type { SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import {
  clearRevisionBlock,
  CHUNK_REVISION_FAMILY,
} from '../../../infrastructure/sqlite/narrative-revisions.js';
import { getLedgerEntry, markLedgerApplied } from '../../../infrastructure/sqlite/ops-ledger.js';
import {
  chunkBlockPrerequisiteMoved,
  RECONSIDERABLE_REASONS,
} from '../../../reflection/application/chunk-reconsider.js';
import type { OperationContext } from '../../domain/operation.js';

/** Blocked rows one run reads while looking for the ones it may clear. */
const RECONSIDER_SCAN_LIMIT = 256;

/** Rows one page of that scan takes. */
const RECONSIDER_PAGE = 64;

/** Where the last run's discovery over blocked rows stopped. One row, naming a revision. */
const RECONSIDER_CURSOR_KEY = 'narrative_seal:blocked_cursor';

type BlockedCursor = { readonly chunkId: string; readonly revisionNo: number };

/**
 * Clears the blocks whose recorded prerequisite no longer holds.
 *
 * Each reason is rechecked against the record its own prerequisite lives in. A suppression block
 * clears on a member that was proved forgotten and is not now; a census block clears when the
 * scopes it could not count are counted; a policy block clears when the bounds in force differ
 * from the bounds it ran under. Sharing one test between them would have done both wrongs at once
 * — leaving a censused chunk blocked forever, and offering a budget refusal that merely shares a
 * reason word with a suppression as though a forget had cleared.
 *
 * Clearing is not attempting: the revision goes back into the ordinary enumeration and takes its
 * turn there by capture position, so a reconsidered attempt cannot jump the older backlog either.
 */
export function reconsiderBlockedAttempts(
  ctx: OperationContext,
  limit: number,
  inForce: Record<string, number>,
): number {
  let cleared = 0;
  for (const attempt of discoverReady(ctx, limit, inForce)) {
    if (clearRevisionBlock(ctx.db, CHUNK_REVISION_FAMILY, attempt.chunkId, attempt.revisionNo)) {
      cleared += 1;
      ctx.logger.info(
        { chunkId: attempt.chunkId, revisionNo: attempt.revisionNo, reason: attempt.reason },
        'narrative seal reconsidered a blocked attempt whose prerequisite moved',
      );
    }
  }
  return cleared;
}

/**
 * The blocked rows this run may clear, discovered across pages rather than off one front page.
 *
 * Which rows are READY is decided from the records after they are read, so a caller bounded to a
 * handful of outputs that always read the first rows in query order saw the same still-blocked
 * prefix every run: a prerequisite that cleared behind it was unreachable however many passes it
 * got, at the bound it was given. The output bound is applied to the ready rows, and discovery
 * continues past the ones that are not — bounded by the scan, and resuming where the last run
 * stopped so a long unchanged prefix is not re-read before the rows behind it.
 *
 * The position wraps at the end of the walk, which is what makes it a position and not a
 * discharge: a row an earlier page passed over is reached again once the walk comes round. Writing
 * it is an ordinary operational write by an operation that is already mutating this store.
 */
function discoverReady(
  ctx: OperationContext,
  limit: number,
  inForce: Record<string, number>,
): readonly BlockedAttempt[] {
  const held: BlockedAttempt[] = [];
  let after = readBlockedCursor(ctx.db);
  let stopped = after;
  let wrapped = after === undefined;
  let scanned = 0;
  while (held.length < limit && scanned < RECONSIDER_SCAN_LIMIT) {
    const page = blockedAttempts(ctx.db, {
      reasons: RECONSIDERABLE_REASONS,
      limit: Math.min(RECONSIDER_PAGE, RECONSIDER_SCAN_LIMIT - scanned),
      ...(after === undefined ? {} : { after }),
    });
    if (page.length === 0) {
      if (wrapped) {
        break;
      }
      wrapped = true;
      after = undefined;
      continue;
    }
    for (const attempt of page) {
      scanned += 1;
      stopped = { chunkId: attempt.chunkId, revisionNo: attempt.revisionNo };
      if (chunkBlockPrerequisiteMoved(ctx.db, attempt, inForce)) {
        held.push(attempt);
        if (held.length >= limit) {
          break;
        }
      }
    }
    after = stopped;
  }
  writeBlockedCursor(ctx.db, stopped);
  return held;
}

function readBlockedCursor(db: SqliteHandle): BlockedCursor | undefined {
  const summary = getLedgerEntry(db, RECONSIDER_CURSOR_KEY)?.summary;
  if (typeof summary !== 'object' || summary === null) {
    return undefined;
  }
  const { chunkId, revisionNo } = summary as { chunkId?: unknown; revisionNo?: unknown };
  return typeof chunkId === 'string' && chunkId !== '' && typeof revisionNo === 'number'
    ? { chunkId, revisionNo }
    : undefined;
}

function writeBlockedCursor(db: SqliteHandle, cursor: BlockedCursor | undefined): void {
  markLedgerApplied(db, RECONSIDER_CURSOR_KEY, cursor === undefined ? {} : { ...cursor });
}
