import { batchBoundUsd } from './batch-bounds.js';
import type { BatchTransport } from './batch-transport.js';
import type { SpendingGuard } from './spending.js';
import type { Logger } from '../logging/logger.js';
import { chargedApiUsd, unaccountedApiRequests } from '../sqlite/api-usage.js';
import {
  settledBatchWorkKeys,
  submittedBatchWork,
  type BatchWorkItem,
} from '../sqlite/batch-work.js';
import type { SqliteHandle } from '../sqlite/database.js';
import { settleGenerationSpend } from '../sqlite/spend-ledger.js';

type ReconcileDeps = {
  readonly db: SqliteHandle;
  readonly logger: Pick<Logger, 'error'>;
  readonly spending?: SpendingGuard;
  readonly now: Date;
};

/**
 * Settles this batch's hold at what its answers were charged, plus a bound on the requests it has
 * not accounted for yet.
 *
 * A results file can be partial, and a row it never mentioned is still at the remote with work to
 * do. Settling the whole hold to the charges on the books would read those requests as free and
 * hand their headroom to the next submission, so the unresolved rows keep a reservation of their
 * own until an answer prices them.
 *
 * Both halves are recomputed rather than accumulated: the charges come from the books by request
 * identity, and the retained part is re-derived from the rows still outstanding. A batch read
 * again, in this process or a later one, settles to the same number instead of a growing one.
 *
 * A charge that cannot be priced leaves the hold untouched at its bound, which is the only honest
 * reading of money nobody can size. A charge with no usage row at all is the same money: the hold
 * settles at its bound as an unresolved obligation rather than at the total of whatever rows did
 * land.
 */
export function reconcileSubmission(
  deps: ReconcileDeps,
  transport: BatchTransport,
  batchId: string,
  owed: ReadonlyMap<string, BatchWorkItem>,
): void {
  const reservationId = [...owed.values()].find(
    (item) => item.reservationId !== undefined,
  )?.reservationId;
  if (reservationId === undefined || deps.spending === undefined) {
    return;
  }
  // Every request this batch has settled was answered, so every one of them is a charge. A
  // settled row with no bill under its own request identity is a charge that was never written
  // down, and the sum of the rows that were written cannot see it. The hold stays at its bound
  // and the day names it as unresolved, which is what an obligation nobody can size costs. It
  // outlives the work: the row is terminal and no answer is coming back to price it.
  const unaccounted = unaccountedApiRequests(
    deps.db,
    settledBatchWorkKeys(deps.db, batchId).map((workKey) => `${batchId}:${workKey}`),
  );
  if (unaccounted.length > 0) {
    settleGenerationSpend(deps.db, reservationId, undefined, deps.now);
    deps.logger.error(
      { batchId, unaccounted: unaccounted.length },
      'answers of this batch carry no usage record; its bound is held as an unaccounted charge',
    );
    return;
  }
  const charged = chargedApiUsd(deps.db, batchId);
  if (charged === undefined) {
    return;
  }
  const unresolved = submittedBatchWork(deps.db, batchId);
  const retained = unresolved.length === 0 ? 0 : batchBoundUsd(transport, unresolved);
  settleGenerationSpend(deps.db, reservationId, charged + retained, deps.now);
}
