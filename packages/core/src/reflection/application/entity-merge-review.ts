import {
  applyEntityMerge,
  collectMergeSignals,
  type EntityMergeWriterDeps,
} from './entity-merge-writer.js';
import { ProposalNotFoundError } from './proposals.js';
import {
  loadEntityDedupDetails,
  type DedupEntityDetail,
} from '../../infrastructure/graph/entity-dedup-queries.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  getEntityMergeProposal,
  resolveEntityMergeProposal,
  type EntityMergeProposalSide,
} from '../../infrastructure/sqlite/entity-merge-proposals.js';
import { selectCanonical } from '../domain/entity-merge.js';

/**
 * The review half of entity-merge detection. Identity on the graph is keyed on `name_norm`
 * alone, so a pair the dedup stage declined is two different names: joining them means deciding
 * they are one referent, a judgment about the world rather than about strings. That decision is
 * a person's, which is why this operator path is the only place these rows are applied.
 *
 * Nothing in the pipeline calls any of this. It is reached from `aion proposals` and nowhere
 * else, matching the supersession review path next to it.
 */

/** Provenance on the merge lineage edge: a person applied this, not the dedup stage. */
export const ENTITY_MERGE_APPLY_METHOD = 'merge_proposal_apply';

/** The graph, the ledger and the log the writer needs; the same three every tier hands it. */
export type EntityMergeReviewDeps = EntityMergeWriterDeps;

export type ApplyEntityMergeProposalInput = {
  readonly id: string;
  readonly now?: Date;
};

export type EntityMergeAlreadyResolved = {
  readonly outcome: 'already_resolved';
  readonly id: string;
  readonly resolvedAt: string;
};

export type EntityMergeStale = {
  readonly outcome: 'stale';
  readonly id: string;
  /** Which side of the pair no longer holds currency, so the pair this row judged cannot merge. */
  readonly missingSide: 'left' | 'right' | 'both';
};

export type EntityMergeAlreadyApplied = {
  readonly outcome: 'already_applied';
  readonly id: string;
  readonly canonical: EntityMergeProposalSide;
  readonly absorbed: EntityMergeProposalSide;
};

/** The two sides resolved to one node, so there was never a second identity to absorb. */
export type EntityMergeNothingToMerge = {
  readonly outcome: 'nothing_to_merge';
  readonly id: string;
  readonly canonical: EntityMergeProposalSide;
};

export type EntityMergeApplied = {
  readonly outcome: 'applied';
  readonly id: string;
  readonly canonical: EntityMergeProposalSide;
  readonly absorbed: EntityMergeProposalSide;
  readonly edgesRedirected: number;
  /** True when the post-commit vector cleanup was swallowed rather than run. */
  readonly vectorCleanupDeferred: boolean;
  /** The evidence record this apply wrote, which is what a later unmerge cites. */
  readonly decisionId: string;
};

export type ApplyEntityMergeProposalResult =
  | EntityMergeAlreadyResolved
  | EntityMergeStale
  | EntityMergeAlreadyApplied
  | EntityMergeNothingToMerge
  | EntityMergeApplied;

export type DismissEntityMergeProposalResult =
  | { readonly dismissed: false; readonly id: string; readonly resolvedAt: string }
  | {
      readonly dismissed: true;
      readonly id: string;
      readonly left: EntityMergeProposalSide;
      readonly right: EntityMergeProposalSide;
    };

function toParty(detail: DedupEntityDetail): EntityMergeProposalSide {
  return { id: detail.id, name: detail.name, type: detail.type };
}

/** Which side of the pair a stale check found gone, given the current-and-present detail rows. */
function missingSideOf(
  left: DedupEntityDetail | undefined,
  right: DedupEntityDetail | undefined,
): 'left' | 'right' | 'both' {
  if (left === undefined && right === undefined) {
    return 'both';
  }
  if (left === undefined) {
    return 'left';
  }
  return 'right';
}

/** Present in the graph and not already superseded by something else in the meantime. */
function currentDetail(detail: DedupEntityDetail | undefined): DedupEntityDetail | undefined {
  return detail?.current === true ? detail : undefined;
}

/** What a decision record says the reasons were when the reason is that a person said so. */
const HUMAN_APPLY_REASON = 'applied from the review queue by a person';

/**
 * Applies one merge proposal a person has reviewed. It takes the same writer every tier of the
 * cascade takes (`entity-merge-writer.ts`), because a merge is a merge regardless of who decided
 * it: the graph write, the decision record and the ledger mark are the same three steps in the
 * same order, and only the tier and the lineage provenance tell the two apart.
 *
 * The record matters most on this path. It is the one merge a person made, so it is the one a
 * reversal most wants to cite, and an apply that wrote no record left `aion unmerge` with a
 * restored node and nothing to say about why it was ever absorbed.
 */
export async function applyEntityMergeProposal(
  deps: EntityMergeReviewDeps,
  input: ApplyEntityMergeProposalInput,
): Promise<ApplyEntityMergeProposalResult> {
  const { driver, db } = deps;
  const proposal = getEntityMergeProposal(db, input.id);
  if (proposal === undefined) {
    throw new ProposalNotFoundError(input.id);
  }
  if (proposal.resolvedAt !== null) {
    return { outcome: 'already_resolved', id: input.id, resolvedAt: proposal.resolvedAt };
  }
  const now = input.now ?? new Date();

  const details = await loadEntityDedupDetails(driver, [proposal.leftId, proposal.rightId]);
  const byId = new Map(details.map((detail) => [detail.id, detail]));
  const left = currentDetail(byId.get(proposal.leftId));
  const right = currentDetail(byId.get(proposal.rightId));
  if (left === undefined || right === undefined) {
    resolveEntityMergeProposal(db, input.id, now.toISOString());
    return { outcome: 'stale', id: input.id, missingSide: missingSideOf(left, right) };
  }

  const pair: readonly [DedupEntityDetail, DedupEntityDetail] = [left, right];
  const canonical = selectCanonical(pair);
  const absorbed = pair[0].id === canonical.id ? pair[1] : pair[0];

  const signals = await collectMergeSignals(driver, canonical, pair);
  const result = await applyEntityMerge(deps, {
    canonical,
    members: pair,
    tier: 'human',
    reasons: [HUMAN_APPLY_REASON],
    signals,
    method: ENTITY_MERGE_APPLY_METHOD,
    now,
  });

  resolveEntityMergeProposal(db, input.id, now.toISOString());
  if (result.status === 'skipped' && result.reason === 'stale') {
    // The pre-check above passed and a writer took a side's currency in the window since;
    // the merge transaction's own post-lock read caught it. Same answer as the pre-check.
    const leftGone = result.staleIds.includes(proposal.leftId);
    const rightGone = result.staleIds.includes(proposal.rightId);
    let missingSide: 'left' | 'right' | 'both' = 'right';
    if (leftGone && rightGone) {
      missingSide = 'both';
    } else if (leftGone) {
      missingSide = 'left';
    }
    return { outcome: 'stale', id: input.id, missingSide };
  }
  if (result.status === 'skipped' && result.reason === 'nothing_to_merge') {
    // Both sides of the row name one node, so nothing was absorbed and no merge happened.
    // Reporting it as already applied would claim one did.
    return { outcome: 'nothing_to_merge', id: input.id, canonical: toParty(canonical) };
  }
  if (result.status !== 'merged') {
    return {
      outcome: 'already_applied',
      id: input.id,
      canonical: toParty(canonical),
      absorbed: toParty(absorbed),
    };
  }

  return {
    outcome: 'applied',
    id: input.id,
    canonical: toParty(canonical),
    absorbed: toParty(absorbed),
    edgesRedirected: result.edgesRedirected,
    vectorCleanupDeferred: result.vectorCleanupDeferred,
    decisionId: result.decisionId,
  };
}

/**
 * The other half of a review: the judgment was wrong and the pair stays two identities.
 * Nothing is written to the graph.
 */
export function dismissEntityMergeProposal(
  db: SqliteHandle,
  id: string,
  now: Date = new Date(),
): DismissEntityMergeProposalResult {
  const proposal = getEntityMergeProposal(db, id);
  if (proposal === undefined) {
    throw new ProposalNotFoundError(id);
  }
  if (proposal.resolvedAt !== null) {
    return { dismissed: false, id, resolvedAt: proposal.resolvedAt };
  }
  resolveEntityMergeProposal(db, id, now.toISOString());
  return {
    dismissed: true,
    id,
    left: { id: proposal.leftId, name: proposal.leftName, type: proposal.leftType },
    right: { id: proposal.rightId, name: proposal.rightName, type: proposal.rightType },
  };
}
