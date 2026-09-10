import {
  readCoverageFence,
  refuseCheckedRead,
  type CheckedRead,
  type SqliteHandle,
} from '@aion/core';
import type { CoverageRefusal } from '@aion/protocol';

/**
 * The completion policy every command shares, for reads with nothing to commit.
 *
 * A command that checked coverage, then awaited a store, has an answer computed under a
 * statement that may no longer be in force. Printing it under the old one describes coverage the
 * substrate does not have, and printing it under the new one relabels a stale reading, so the
 * answer is refused and the reader asks again. The refusal itself is built by the shared helper
 * the checked recall commits under, so every surface refuses in one voice.
 */
export function completionRefusal(
  db: SqliteHandle,
  read: CheckedRead,
): CoverageRefusal | undefined {
  const fence = readCoverageFence(db);
  if (fence === read.context.coverageEpoch) {
    return undefined;
  }
  const refused = refuseCheckedRead(
    db,
    read,
    fence === undefined ? 'coverage_store_unavailable' : 'coverage_changed',
  );
  return refused.status === 'refused' ? refused.refusal : undefined;
}
