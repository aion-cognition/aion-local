import type { Driver } from 'neo4j-driver';

import { ProposalNotFoundError } from './proposals.js';
import {
  clearEntityVectors,
  loadEntityDedupDetails,
  redirectAndAbsorb,
  type DedupEntityDetail,
} from '../../infrastructure/graph/entity-dedup-queries.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  getEntityMergeProposal,
  resolveEntityMergeProposal,
  type EntityMergeProposalSide,
} from '../../infrastructure/sqlite/entity-merge-proposals.js';
import { isLedgerApplied, markLedgerApplied } from '../../infrastructure/sqlite/ops-ledger.js';
import {
  entityMergeLedgerKey,
  mergeAccessCount,
  mergeAliases,
  mergeLastAccessed,
  selectCanonical,
} from '../domain/entity-merge.js';

/**
 * The review half of entity-merge detection. Uniqueness on the graph is keyed on
 * `(name_norm, type)`, so a cross-type pair the dedup stage found is two permanently separate
 * identities: joining them means deciding which type the extraction got wrong, a judgment
 * about the world rather than about strings. That decision is a person's, which is why this
 * operator path is the only place these rows are applied.
 *
 * Nothing in the pipeline calls any of this. It is reached from `aion proposals` and nowhere
 * else, matching the supersession review path next to it.
 */

/** Provenance on the merge lineage edge: a person applied this, not the dedup stage. */
export const ENTITY_MERGE_APPLY_METHOD = 'merge_proposal_apply';

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

export type EntityMergeApplied = {
  readonly outcome: 'applied';
  readonly id: string;
  readonly canonical: EntityMergeProposalSide;
  readonly absorbed: EntityMergeProposalSide;
  readonly edgesRedirected: number;
  /** True when the post-commit vector cleanup was swallowed rather than run. */
  readonly vectorCleanupDeferred: boolean;
};

export type ApplyEntityMergeProposalResult =
  EntityMergeAlreadyResolved | EntityMergeStale | EntityMergeAlreadyApplied | EntityMergeApplied;

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

/**
 * Applies one merge proposal a person has reviewed. The write mirrors what the dedup stage
 * runs for an automatic merge (`EntityDedupStage.#mergeGroup`), because a merge is a merge
 * regardless of who decided it; only the provenance on the lineage edge tells the two apart.
 */
export async function applyEntityMergeProposal(
  driver: Driver,
  db: SqliteHandle,
  input: ApplyEntityMergeProposalInput,
): Promise<ApplyEntityMergeProposalResult> {
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
  const mergedIds = [absorbed.id];
  const key = entityMergeLedgerKey(canonical.id, mergedIds);

  if (isLedgerApplied(db, key)) {
    resolveEntityMergeProposal(db, input.id, now.toISOString());
    return {
      outcome: 'already_applied',
      id: input.id,
      canonical: toParty(canonical),
      absorbed: toParty(absorbed),
    };
  }

  const merged = await redirectAndAbsorb(driver, {
    canonicalId: canonical.id,
    mergedIds,
    aliases: mergeAliases(canonical.name, pair),
    accessCount: mergeAccessCount(pair),
    lastAccessed: mergeLastAccessed(pair),
    supersedeSignals: ['entity_merge'],
    supersedeProvenance: [ENTITY_MERGE_APPLY_METHOD],
    mergedRecords: pair
      .filter((member) => member.id !== canonical.id)
      .map((member) => ({
        id: member.id,
        name: member.name,
        nameNorm: member.nameNorm,
        type: member.type,
        aliases: member.aliases,
      })),
    ledgerKey: key,
    now,
  });

  // Best-effort, like the dedup stage's own cleanup: index maintenance never fails the apply.
  let vectorCleanupDeferred = false;
  try {
    await clearEntityVectors(driver, mergedIds);
  } catch {
    vectorCleanupDeferred = true;
  }

  markLedgerApplied(db, key, { canonicalId: canonical.id, mergedIds });
  resolveEntityMergeProposal(db, input.id, now.toISOString());

  return {
    outcome: 'applied',
    id: input.id,
    canonical: toParty(canonical),
    absorbed: toParty(absorbed),
    edgesRedirected: merged.edgesRedirected,
    vectorCleanupDeferred,
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
