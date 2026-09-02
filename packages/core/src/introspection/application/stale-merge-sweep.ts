import type { Driver } from 'neo4j-driver';

import { findNodesWithoutCurrency } from '../../infrastructure/graph/supersession-queries.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import { abortRequested } from '../../infrastructure/providers/deadline-signal.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  listOpenEntityMergeProposalsAfter,
  resolveEntityMergeProposal,
  type EntityMergeProposal,
} from '../../infrastructure/sqlite/entity-merge-proposals.js';
import {
  getLedgerEntry,
  isLedgerApplied,
  markLedgerApplied,
} from '../../infrastructure/sqlite/ops-ledger.js';

/**
 * Resolves an entity-merge proposal whose pair lost a side, so nobody is asked to decide about
 * a node that is no longer there.
 *
 * The supersession path has read currency immediately before it writes since it shipped, so a
 * judgment whose losing side went away is never scored as a close. The merge lane had nothing
 * of the kind: a later merge absorbing one of the two entities left the pair sitting in `aion
 * proposals` as if it were still a question.
 *
 * There is no horizon here on purpose. Age is what hygiene weighs when it does not know
 * whether a pair is worth deciding. A pair with a closed side is not undecided, it is
 * finished, and waiting two weeks to say so only keeps the queue misleading for two weeks.
 * The resolution is a note in the ledger naming which side went, and `aion proposals reopen`
 * is the undo, the same as for every other dismissal.
 */

export const STALE_MERGE_LEDGER_PREFIX = 'entity_merge_stale:';

/** Its own namespace, not hygiene's, so a stale resolution and a hygiene dismissal of one row cannot overwrite each other. */
export function staleMergeLedgerKey(proposalId: string): string {
  return `${STALE_MERGE_LEDGER_PREFIX}${proposalId}`;
}

export const STALE_MERGE_REASON =
  'a side of this pair lost currency, so there is nothing left to merge';

/** Bounds one run's work, so a queue that has gone stale wholesale drains over ticks. */
export const STALE_SWEEP_CEILING = 200;

/**
 * Where the last run stopped reading. A pair whose two sides both hold currency is not stale
 * and is never resolved by this sweep, so a run that always started at the head of the queue
 * would read the same page of undecidable rows forever and never reach a finished pair behind
 * them. A short page means the walk reached the end of the queue, and the cursor goes back to
 * the start so rows opened since are read next.
 */
export const STALE_MERGE_CURSOR_KEY = 'entity_merge_stale_cursor';

export type StaleMergeSweepInput = {
  readonly db: SqliteHandle;
  readonly driver: Driver;
  readonly logger: Logger;
  readonly now: Date;
  readonly limit?: number;
  /** The loop's abort. A shutdown mid-sweep stops before the next resolve rather than after all of them. */
  readonly signal?: AbortSignal;
};

export type StaleMergeSweepResult = {
  readonly examined: number;
  readonly resolved: number;
};

function readCursor(db: SqliteHandle): number | undefined {
  const summary = getLedgerEntry(db, STALE_MERGE_CURSOR_KEY)?.summary;
  if (typeof summary !== 'object' || summary === null) {
    return undefined;
  }
  const { afterRowid } = summary as { afterRowid?: unknown };
  return typeof afterRowid === 'number' && afterRowid > 0 ? afterRowid : undefined;
}

export async function sweepStaleMergeProposals(
  input: StaleMergeSweepInput,
): Promise<StaleMergeSweepResult> {
  if (abortRequested(input.signal)) {
    return { examined: 0, resolved: 0 };
  }

  const limit = input.limit ?? STALE_SWEEP_CEILING;
  const afterRowid = readCursor(input.db);
  const page = listOpenEntityMergeProposalsAfter(input.db, {
    limit,
    ...(afterRowid === undefined ? {} : { afterRowid }),
  });
  const open = page.proposals;
  markLedgerApplied(input.db, STALE_MERGE_CURSOR_KEY, {
    afterRowid: open.length < limit ? 0 : (page.lastRowid ?? 0),
  });
  if (open.length === 0) {
    return { examined: 0, resolved: 0 };
  }

  const gone = new Set(
    await findNodesWithoutCurrency(
      input.driver,
      open.flatMap((proposal) => [proposal.leftId, proposal.rightId]),
    ),
  );

  // resolve() and the ledger stamp as one commit: a crash between them leaves a row resolved
  // with no record of why, which reads exactly like a bug. better-sqlite3 transactions are
  // synchronous, so nothing inside this awaits.
  const resolve = input.db.transaction(
    (proposal: EntityMergeProposal, goneSides: string[], reopened: boolean) => {
      if (!resolveEntityMergeProposal(input.db, proposal.id, input.now.toISOString())) {
        return false;
      }
      markLedgerApplied(input.db, staleMergeLedgerKey(proposal.id), {
        reason: STALE_MERGE_REASON,
        goneSides,
        // True when a person reopened a row this sweep had already closed. The stamp is
        // overwritten either way, so without this the second close leaves no trace of the first.
        reopened,
        leftId: proposal.leftId,
        leftName: proposal.leftName,
        rightId: proposal.rightId,
        rightName: proposal.rightName,
        episodeId: proposal.episodeId,
      });
      return true;
    },
  );

  let resolved = 0;
  let examined = 0;
  for (const proposal of open) {
    if (abortRequested(input.signal)) {
      break;
    }
    examined += 1;
    const goneSides = [proposal.leftId, proposal.rightId].filter((id) => gone.has(id));
    if (goneSides.length === 0) {
      continue;
    }
    const reopened = isLedgerApplied(input.db, staleMergeLedgerKey(proposal.id));
    if (!resolve(proposal, goneSides, reopened)) {
      input.logger.info(
        { proposalId: proposal.id },
        'stale merge sweep lost the race: the row was already resolved',
      );
      continue;
    }
    resolved += 1;
    input.logger.info(
      { proposalId: proposal.id, goneSides, reopened },
      'stale merge sweep resolved a proposal with nothing left to merge',
    );
  }

  return { examined, resolved };
}
