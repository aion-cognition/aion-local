import type { Driver } from 'neo4j-driver';
import { supersede } from '../../infrastructure/graph/bitemporal.js';
import {
  findSourceEpisodeId,
  supersedeEpisode,
} from '../../infrastructure/graph/episode-supersession.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  getSupersessionProposal,
  resolveSupersessionProposal,
  type SupersessionProposal,
} from '../../infrastructure/sqlite/supersession-proposals.js';

/**
 * The review half of propose-only supersession. Auto-apply is off because the judge emits 1.0
 * on every firing and three of three live firings were false, so every judgment is a row a
 * person decides on, and a decision needs somewhere to be made. Without this the proposal
 * table is write-only and a correction can never change what recall answers, which is the
 * user-visible failure the whole posture was meant to fix rather than entrench.
 *
 * Nothing in the pipeline calls any of this. It is reached from `aion proposals` and nowhere
 * else, which is what keeps "a person decided" true.
 */

/** Provenance for a human review, distinct from a judged contradiction and from a replay. */
export const PROPOSAL_APPLY_METHOD = 'supersession_proposal_applied';

const PROPOSAL_APPLY_SIGNALS = ['proposal_review'];

export type ApplyProposalInput = {
  readonly id: string;
  /**
   * Widen the closure from the judged claim to the episode it came from, which also closes
   * every other fact whose only open source is that episode. The right choice when the whole
   * observation was wrong; the wrong one when a single claim inside a good session was.
   */
  readonly episode?: boolean;
  readonly now?: Date;
};

export type ApplyProposalResult = {
  readonly proposal: SupersessionProposal;
  /** What was actually closed: the judged node, or the episode and its derived family. */
  readonly closedIds: readonly string[];
  readonly supersededBy: string;
};

export class ProposalNotFoundError extends Error {
  constructor(id: string) {
    super(`no supersession proposal with id ${id}`);
    this.name = 'ProposalNotFoundError';
  }
}

export class ProposalAlreadyResolvedError extends Error {
  constructor(id: string, resolvedAt: string) {
    super(`supersession proposal ${id} was already resolved at ${resolvedAt}`);
    this.name = 'ProposalAlreadyResolvedError';
  }
}

function open(db: SqliteHandle, id: string): SupersessionProposal {
  const proposal = getSupersessionProposal(db, id);
  if (proposal === undefined) {
    throw new ProposalNotFoundError(id);
  }
  if (proposal.resolvedAt !== null) {
    throw new ProposalAlreadyResolvedError(id, proposal.resolvedAt);
  }
  return proposal;
}

/**
 * Closes the judged claim and marks the proposal resolved, in that order: a graph write that
 * succeeded and a row that says otherwise is recoverable by re-reading the graph, while the
 * reverse would hide an unapplied judgment behind a resolved row.
 *
 * In `episode` mode the correction's own episode supersedes the claim's source episode, which
 * is what propagates the closure to the rest of the family. A stale attribute fact extracted
 * from the same observation otherwise keeps answering as current.
 */
export async function applySupersessionProposal(
  driver: Driver,
  db: SqliteHandle,
  input: ApplyProposalInput,
): Promise<ApplyProposalResult> {
  const proposal = open(db, input.id);
  const now = input.now ?? new Date();
  const provenance = [PROPOSAL_APPLY_METHOD];

  if (input.episode === true) {
    const sourceId = await findSourceEpisodeId(driver, proposal.oldId);
    if (sourceId === undefined) {
      throw new Error(
        `proposal ${proposal.id}: ${proposal.oldId} has no open source episode to supersede`,
      );
    }
    const applied = await supersedeEpisode(driver, {
      oldId: sourceId,
      newId: proposal.episodeId,
      now,
      signals: PROPOSAL_APPLY_SIGNALS,
      provenance,
    });
    resolveSupersessionProposal(db, proposal.id, now.toISOString());
    return {
      proposal,
      closedIds: [sourceId, ...applied.propagation.closedIds],
      supersededBy: proposal.episodeId,
    };
  }

  await supersede(driver, {
    oldId: proposal.oldId,
    newId: proposal.newId,
    now,
    signals: PROPOSAL_APPLY_SIGNALS,
    provenance,
  });
  resolveSupersessionProposal(db, proposal.id, now.toISOString());
  return { proposal, closedIds: [proposal.oldId], supersededBy: proposal.newId };
}

/**
 * The other half of a review: the judgment was wrong and the claim stands. Nothing is written
 * to the graph, and the row leaves the queue so the same false positive is not re-decided every
 * time someone looks.
 */
export function dismissSupersessionProposal(
  db: SqliteHandle,
  id: string,
  now: Date = new Date(),
): SupersessionProposal {
  const proposal = open(db, id);
  resolveSupersessionProposal(db, id, now.toISOString());
  return proposal;
}
