import type { BatchTransport } from './batch-transport.js';
import type { GenerationProvider } from './types.js';
import type { Logger } from '../logging/logger.js';
import type { SqliteHandle } from '../sqlite/database.js';
import { getLedgerEntry, listLedgerEntries, markLedgerApplied } from '../sqlite/ops-ledger.js';

type ReleaseDeps = {
  readonly db: SqliteHandle;
  readonly logger: Pick<Logger, 'warn'>;
};

/** Where a job whose files the vendor still holds is remembered until the deletion succeeds. */
const RELEASE_LEDGER_PREFIX = 'batch_release:';

function releaseKey(provider: GenerationProvider, batchId: string): string {
  return `${RELEASE_LEDGER_PREFIX}${provider}:${batchId}`;
}

/**
 * Deletes what the vendor still stores for a job no row is waiting on. The job leaves the
 * outstanding list once its last row settles, so a deletion that fails is written to the ops
 * ledger and tried again on every later pass until it succeeds, whether or not that pass has any
 * rows of its own to read. It never holds up the settlement already written.
 */
export async function releaseBatch(
  deps: ReleaseDeps,
  transport: BatchTransport,
  batchId: string,
): Promise<void> {
  if (transport.release === undefined) {
    return;
  }
  const key = releaseKey(transport.provider, batchId);
  try {
    await transport.release(batchId);
    if (getLedgerEntry(deps.db, key) !== undefined) {
      markLedgerApplied(deps.db, key, { batchId, released: true });
    }
  } catch (err) {
    markLedgerApplied(deps.db, key, { batchId, released: false });
    deps.logger.warn(
      { err, batchId },
      'settled batch files could not be deleted at the vendor; the next pass tries again',
    );
  }
}

export type PendingRelease = {
  readonly batchId: string;
  /** When the last deletion attempt failed, by the wall clock the ledger stamps with. */
  readonly failedAt: string;
};

/**
 * The deletions an earlier pass could not finish at this provider. They outlive the rows they
 * came from, so a lane with nothing pending or submitted can still owe one.
 */
export function pendingReleases(
  db: SqliteHandle,
  provider: GenerationProvider,
): readonly PendingRelease[] {
  const pending: PendingRelease[] = [];
  for (const entry of listLedgerEntries(db, `${RELEASE_LEDGER_PREFIX}${provider}:`)) {
    const summary = entry.summary as { batchId?: unknown; released?: unknown } | undefined;
    if (summary?.released !== false || typeof summary.batchId !== 'string') {
      continue;
    }
    pending.push({ batchId: summary.batchId, failedAt: entry.appliedAt });
  }
  return pending;
}

/** The deletions an earlier pass could not finish. */
export async function retryReleases(deps: ReleaseDeps, transport: BatchTransport): Promise<void> {
  if (transport.release === undefined) {
    return;
  }
  for (const { batchId } of pendingReleases(deps.db, transport.provider)) {
    await releaseBatch(deps, transport, batchId);
  }
}
