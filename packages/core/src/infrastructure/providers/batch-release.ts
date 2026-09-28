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
 * ledger and tried again on every later pass until it succeeds. It never holds up the settlement
 * already written.
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

/** The deletions an earlier pass could not finish. */
export async function retryReleases(deps: ReleaseDeps, transport: BatchTransport): Promise<void> {
  if (transport.release === undefined) {
    return;
  }
  for (const entry of listLedgerEntries(
    deps.db,
    `${RELEASE_LEDGER_PREFIX}${transport.provider}:`,
  )) {
    const summary = entry.summary as { batchId?: unknown; released?: unknown } | undefined;
    if (summary?.released !== false || typeof summary.batchId !== 'string') {
      continue;
    }
    await releaseBatch(deps, transport, summary.batchId);
  }
}
