import type { Driver } from 'neo4j-driver';

import { supersede } from '../../infrastructure/graph/bitemporal.js';
import {
  findSourceEpisodeId,
  supersedeEpisode,
} from '../../infrastructure/graph/episode-supersession.js';
import { markNarrativesForRegrounding } from '../../infrastructure/graph/narrative-queries.js';
import {
  supersedeSubjectFamily,
  type ClaimSubject,
  type SubjectSibling,
} from '../../infrastructure/graph/subject-family.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  getSupersessionProposal,
  resolveSupersessionProposal,
  type SupersessionProposal,
} from '../../infrastructure/sqlite/supersession-proposals.js';

/**
 * The review half of propose-only supersession. Auto-apply is off because the judge answers
 * with one confidence for every firing, so every judgment is a row a person decides on, and a
 * decision needs somewhere to be made. Without this the proposal table is write-only and a
 * correction can never change what recall answers, which is the user-visible failure the whole
 * posture was meant to fix rather than entrench.
 *
 * Nothing in the pipeline calls any of this. It is reached from `aion proposals` and nowhere
 * else, which is what keeps "a person decided" true.
 */

/** Provenance for a human review, distinct from a judged contradiction and from a replay. */
export const PROPOSAL_APPLY_METHOD = 'supersession_proposal_applied';

const PROPOSAL_APPLY_SIGNALS = ['proposal_review'];

/**
 * How wide a correction cuts.
 *
 * `family` is the default because the narrow cut measured no change in what recall answers: a
 * claim's siblings were extracted from the same observation, and closing one of them leaves
 * the others stating the old value as current. `claim` is the escape for a single wrong
 * sentence inside an observation that is otherwise right. `episode` closes everything derived
 * from that observation, definitions and historical records included, and is the right choice
 * only when the whole observation was wrong.
 */
export type ApplyScope = 'family' | 'claim' | 'episode';

export const DEFAULT_APPLY_SCOPE: ApplyScope = 'family';

export type ApplyProposalInput = {
  readonly id: string;
  readonly scope?: ApplyScope;
  /**
   * How close a sibling has to be to the judged claim before a family apply closes it too.
   * Required rather than defaulted: over-closing takes true claims out of every future answer,
   * and a caller that has not said where the line sits has not thought about it.
   */
  readonly relatednessFloor: number;
  readonly now?: Date;
};

export type ApplyProposalResult = {
  readonly proposal: SupersessionProposal;
  readonly scope: ApplyScope;
  /** What was actually closed, judged claim first. */
  readonly closedIds: readonly string[];
  readonly supersededBy: string;
  /** The siblings a family apply took, with the subject each of them named. */
  readonly siblings: readonly SubjectSibling[];
  /** Siblings that named the same subject and were left open, because the correction is not about them. */
  readonly heldSiblings: readonly SubjectSibling[];
  /** The subject names the family matched on; empty means nothing widened the close. */
  readonly subjects: readonly string[];
  /**
   * Entity descriptions that restated the closed claim and were cleared. The entities stay:
   * a gloss is a sentence written once by the first episode to name a subject, and it was the
   * carrier that kept a corrected substrate answering with the old owner at rank 1.
   */
  readonly retiredGlosses: readonly ClaimSubject[];
  /** Descriptions of the same subjects that stand, because they assert something else. */
  readonly openGlosses: readonly ClaimSubject[];
  /**
   * Narratives of the affected sessions, marked for regrounding. A narrative compresses the
   * claims of its session and carries no supersession lineage of its own, so a correction
   * leaves it standing as current, restating the closed claim, with nothing to say it was
   * corrected. The marker is what the regrounding operation reads.
   */
  readonly regroundedNarratives: readonly string[];
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

async function applyEpisode(
  driver: Driver,
  proposal: SupersessionProposal,
  now: Date,
): Promise<Omit<ApplyProposalResult, 'proposal' | 'scope' | 'regroundedNarratives'>> {
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
    provenance: [PROPOSAL_APPLY_METHOD],
  });
  return {
    closedIds: [sourceId, ...applied.propagation.closedIds],
    supersededBy: proposal.episodeId,
    siblings: [],
    heldSiblings: [],
    subjects: [],
    retiredGlosses: [],
    openGlosses: [],
  };
}

/**
 * Closes what the scope names and marks the proposal resolved, in that order: a graph write
 * that succeeded and a row that says otherwise is recoverable by re-reading the graph, while
 * the reverse would hide an unapplied judgment behind a resolved row.
 */
export async function applySupersessionProposal(
  driver: Driver,
  db: SqliteHandle,
  input: ApplyProposalInput,
): Promise<ApplyProposalResult> {
  const proposal = open(db, input.id);
  const now = input.now ?? new Date();
  const scope = input.scope ?? DEFAULT_APPLY_SCOPE;

  const applied = await applyScope(driver, proposal, scope, now, input.relatednessFloor);
  // After the close, not inside it: the marker is a repair instruction rather than part of the
  // correction, and a narrative left unmarked costs a stale sentence, not a wrong close.
  const regroundedNarratives = await markNarrativesForRegrounding(driver, applied.closedIds);
  resolveSupersessionProposal(db, proposal.id, now.toISOString());
  return { proposal, scope, ...applied, regroundedNarratives };
}

async function applyScope(
  driver: Driver,
  proposal: SupersessionProposal,
  scope: ApplyScope,
  now: Date,
  relatednessFloor: number,
): Promise<Omit<ApplyProposalResult, 'proposal' | 'scope' | 'regroundedNarratives'>> {
  if (scope === 'episode') {
    return applyEpisode(driver, proposal, now);
  }

  if (scope === 'claim') {
    await supersede(driver, {
      oldId: proposal.oldId,
      newId: proposal.newId,
      now,
      signals: PROPOSAL_APPLY_SIGNALS,
      provenance: [PROPOSAL_APPLY_METHOD],
    });
    return {
      closedIds: [proposal.oldId],
      supersededBy: proposal.newId,
      siblings: [],
      heldSiblings: [],
      subjects: [],
      retiredGlosses: [],
      openGlosses: [],
    };
  }

  const family = await supersedeSubjectFamily(driver, {
    claimId: proposal.oldId,
    newId: proposal.newId,
    relatednessFloor,
    now,
    signals: PROPOSAL_APPLY_SIGNALS,
    provenance: [PROPOSAL_APPLY_METHOD],
  });
  return {
    closedIds: family.closedIds,
    supersededBy: proposal.newId,
    siblings: family.siblings,
    heldSiblings: family.heldSiblings,
    subjects: family.subjects,
    retiredGlosses: family.retiredGlosses,
    openGlosses: family.openGlosses,
  };
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
