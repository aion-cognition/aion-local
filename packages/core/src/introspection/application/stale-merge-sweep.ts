import type { Driver } from 'neo4j-driver';

import { findNodesWithoutCurrency } from '../../infrastructure/graph/supersession-queries.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  listEntityMergeProposals,
  resolveEntityMergeProposal,
  type EntityMergeProposal,
} from '../../infrastructure/sqlite/entity-merge-proposals.js';
import { markLedgerApplied } from '../../infrastructure/sqlite/ops-ledger.js';

/**
 * The merge lane's `goneSides`. The supersession path has read currency immediately before it
 * writes since it shipped, so a judgment whose losing side went away is never scored as a
 * close; the merge lane had nothing of the kind, and a fifth of the measured open queue was
 * pairs one of whose entities a later merge had already absorbed. A person opening `aion
 * proposals` was being asked to decide about a node that no longer exists.
 *
 * There is no horizon here on purpose. Age is what hygiene weighs when it does not know
 * whether a pair is worth deciding; a pair with a closed side is not undecided, it is
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

export type StaleMergeSweepInput = {
  readonly db: SqliteHandle;
  readonly driver: Driver;
  readonly logger: Logger;
  readonly now: Date;
  readonly limit?: number;
};

export type StaleMergeSweepResult = {
  readonly examined: number;
  readonly resolved: number;
};

function openProposals(db: SqliteHandle, limit: number): EntityMergeProposal[] {
  return listEntityMergeProposals(db)
    .filter((proposal) => proposal.resolvedAt === null)
    .slice(0, limit);
}

export async function sweepStaleMergeProposals(
  input: StaleMergeSweepInput,
): Promise<StaleMergeSweepResult> {
  const open = openProposals(input.db, input.limit ?? STALE_SWEEP_CEILING);
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
  const resolve = input.db.transaction((proposal: EntityMergeProposal, goneSides: string[]) => {
    if (!resolveEntityMergeProposal(input.db, proposal.id, input.now.toISOString())) {
      return false;
    }
    markLedgerApplied(input.db, staleMergeLedgerKey(proposal.id), {
      reason: STALE_MERGE_REASON,
      goneSides,
      leftId: proposal.leftId,
      leftName: proposal.leftName,
      rightId: proposal.rightId,
      rightName: proposal.rightName,
      episodeId: proposal.episodeId,
    });
    return true;
  });

  let resolved = 0;
  for (const proposal of open) {
    const goneSides = [proposal.leftId, proposal.rightId].filter((id) => gone.has(id));
    if (goneSides.length === 0) {
      continue;
    }
    if (!resolve(proposal, goneSides)) {
      input.logger.info(
        { proposalId: proposal.id },
        'stale merge sweep lost the race: the row was already resolved',
      );
      continue;
    }
    resolved += 1;
    input.logger.info(
      { proposalId: proposal.id, goneSides },
      'stale merge sweep resolved a proposal with nothing left to merge',
    );
  }

  return { examined: open.length, resolved };
}
