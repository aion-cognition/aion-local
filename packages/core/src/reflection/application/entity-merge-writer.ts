import type { Driver } from 'neo4j-driver';

import type { DedupEntityDetail } from '../../infrastructure/graph/entity-dedup-queries.js';
import {
  clearEntityVectors,
  redirectAndAbsorb,
} from '../../infrastructure/graph/entity-merge-queries.js';
import { readEntityPairSignals } from '../../infrastructure/graph/entity-signal-queries.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  entityMergeDecisionKey,
  recordEntityMergeDecision,
  type EntityMergeJudgeVerdicts,
  type EntityMergeSignals,
  type EntityMergeTier,
} from '../../infrastructure/sqlite/entity-merge-decisions.js';
import { isLedgerApplied, markLedgerApplied } from '../../infrastructure/sqlite/ops-ledger.js';
import { nameFormRelation } from '../domain/entity-cascade.js';
import {
  ENTITY_CASCADE_VERSION,
  entityMergeLedgerKey,
  mergeAccessCount,
  mergeAliases,
  mergeLastAccessed,
} from '../domain/entity-merge.js';

/**
 * The one path any tier of the cascade takes to write a merge. Whoever decided, the write is
 * the same four statements in the same order: redirect and absorb inside one transaction, record
 * what the decision knew, clear the absorbed vectors, mark the ledger.
 *
 * The decision record is not optional and not a side channel. A merge with no record is a merge
 * nobody can argue with later, so it is written here rather than left to each caller, and the
 * merge provenance the graph keeps carries the record's idempotency key so an unmerge reaches
 * the evidence without recomputing anything.
 *
 * Order matters at the two failure points. The record lands after the graph commit, so nothing
 * ever claims a merge that did not happen, and the record and the ledger mark are one SQLite
 * transaction, so neither can outlive the other. What no ordering closes is the window between
 * the two stores: the graph carries the record's key from the moment it commits, and a process
 * that dies before the SQLite write leaves that key pointing at nothing. Nothing replays it,
 * because the candidate reads are currency-filtered and the absorbed side is already closed, so
 * `merge_decision_reconcile` walks the trail afterwards and writes the missing row back.
 */

export type EntityMergeWriterDeps = {
  readonly driver: Driver;
  readonly db: SqliteHandle;
  readonly logger: Logger;
};

export type EntityMergeWriteInput = {
  readonly canonical: DedupEntityDetail;
  /** Every identity in the group, canonical included; the canonical is filtered out here. */
  readonly members: readonly DedupEntityDetail[];
  readonly tier: EntityMergeTier;
  readonly reasons: readonly string[];
  readonly signals: readonly EntityMergeSignals[];
  /** Absent for a deterministic tier, which reaches its answer without asking a model. */
  readonly judge?: EntityMergeJudgeVerdicts;
  /** What the `SUPERSEDES` lineage should say decided this merge. */
  readonly method: string;
  /**
   * Which cascade decided it, stamped on the record and on the gate in front of it. Defaults to
   * the shipped version; a replay of an old decision under new prompts passes its own.
   */
  readonly cascadeVersion?: string;
  readonly now: Date;
};

export type EntityMergeWriteResult =
  | {
      readonly status: 'merged';
      readonly mergedIds: readonly string[];
      readonly decisionId: string;
      readonly edgesRedirected: number;
      /** True when the post-commit vector cleanup was swallowed rather than run. */
      readonly vectorCleanupDeferred: boolean;
    }
  | { readonly status: 'skipped'; readonly reason: 'already_applied' | 'nothing_to_merge' }
  | {
      readonly status: 'skipped';
      readonly reason: 'stale';
      /** The sides that lost currency between the decision's snapshot and the merge's locks. */
      readonly staleIds: readonly string[];
    };

/**
 * The measured evidence for each absorbed member against the canonical, in one graph read for
 * the whole group. Tier 0 collects it too: a deterministic merge still deserves a record saying
 * what the two shared, and it is exactly what a person reversing the merge wants to read.
 *
 * A pair the signal read returns nothing for keeps its counted facts and leaves the graph ones
 * absent. Zero-filling them would turn a thing nobody could measure into evidence against the
 * merge, which is backwards.
 */
export async function collectMergeSignals(
  driver: Driver,
  canonical: DedupEntityDetail,
  members: readonly DedupEntityDetail[],
  nominatingCosines: ReadonlyMap<string, number> = new Map(),
): Promise<EntityMergeSignals[]> {
  const absorbed = members.filter((member) => member.id !== canonical.id);
  const measured = await readEntityPairSignals(
    driver,
    absorbed.map((member) => ({ leftId: canonical.id, rightId: member.id })),
  );
  const byId = new Map(measured.map((signal) => [signal.rightId, signal]));

  return absorbed.map((member) => {
    const pair = byId.get(member.id);
    const cosine = nominatingCosines.get(member.id);
    return {
      memberId: member.id,
      ...(cosine === undefined ? {} : { nominatingCosine: cosine }),
      ...(pair === undefined
        ? {}
        : {
            sharedEpisodeCount: pair.sharedEpisodeCount,
            sharedEpisodeJaccard: pair.sharedEpisodeJaccard,
            neighborOverlapCount: pair.neighborOverlapCount,
            neighborOverlapJaccard: pair.neighborOverlapJaccard,
          }),
      ...(pair?.temporalGapDays === undefined ? {} : { temporalGapDays: pair.temporalGapDays }),
      nameFormRelation: nameFormRelation(canonical.name, member.name),
      canonicalMentionCount: canonical.mentionCount,
      memberMentionCount: member.mentionCount,
    };
  });
}

export async function applyEntityMerge(
  deps: EntityMergeWriterDeps,
  input: EntityMergeWriteInput,
): Promise<EntityMergeWriteResult> {
  // One entry per absorbed identity, because the salience roll-up and the merged records are
  // taken from this list: a member repeated in the group would otherwise be counted twice and
  // written twice, while the ledger key and the graph write saw it once.
  const seen = new Set<string>();
  const absorbed = input.members.filter((member) => {
    if (member.id === input.canonical.id || seen.has(member.id)) {
      return false;
    }
    seen.add(member.id);
    return true;
  });
  const mergedIds = [...seen].sort();
  if (mergedIds.length === 0) {
    return { status: 'skipped', reason: 'nothing_to_merge' };
  }

  const cascadeVersion = input.cascadeVersion ?? ENTITY_CASCADE_VERSION;
  const ledgerKey = entityMergeLedgerKey(cascadeVersion, input.canonical.id, mergedIds);
  if (isLedgerApplied(deps.db, ledgerKey)) {
    return { status: 'skipped', reason: 'already_applied' };
  }
  const decisionKey = entityMergeDecisionKey(input.canonical.id, mergedIds, cascadeVersion);

  const merged = await redirectAndAbsorb(deps.driver, {
    canonicalId: input.canonical.id,
    canonicalNameNorm: input.canonical.nameNorm,
    mergedIds,
    // The absorbed side only. The canonical's own aliases and salience are read inside the
    // merge transaction, where a write that landed after this stage's detail load is visible;
    // computing them here would hand the graph a value taken minutes before the lock.
    aliases: mergeAliases(input.canonical.name, absorbed),
    accessCount: mergeAccessCount(absorbed),
    lastAccessed: mergeLastAccessed(absorbed),
    supersedeSignals: ['entity_merge'],
    supersedeProvenance: [input.method],
    mergedRecords: absorbed.map((member) => ({
      id: member.id,
      name: member.name,
      nameNorm: member.nameNorm,
      type: member.type,
      aliases: member.aliases,
    })),
    ledgerKey,
    decisionKey,
    now: input.now,
  });

  // The ledger is not marked: the merge did not happen. The candidate reads filter on
  // currency, so a group with a closed side cannot re-form; one a reopen resurrects
  // deserves a fresh decision rather than a stamp saying this one applied.
  if (merged.status === 'stale') {
    deps.logger.info(
      { canonicalId: input.canonical.id, mergedIds, staleIds: merged.staleIds },
      'entity merge skipped, a side lost currency since the decision',
    );
    return { status: 'skipped', reason: 'stale', staleIds: merged.staleIds };
  }

  // One SQLite transaction over both, and nothing awaited between them. A mark with no record
  // is a merge nobody can argue with later; a record with no mark invites a replay of a merge
  // that already happened, which the currency re-read then refuses without ever marking it.
  const decisionId = deps.db.transaction((): string => {
    const id = recordEntityMergeDecision(deps.db, {
      canonicalId: input.canonical.id,
      memberIds: mergedIds,
      tier: input.tier,
      reasons: input.reasons,
      signals: input.signals,
      ...(input.judge === undefined ? {} : { judge: input.judge }),
      cascadeVersion,
      createdAt: input.now.toISOString(),
    });
    markLedgerApplied(deps.db, ledgerKey, {
      canonicalId: input.canonical.id,
      mergedIds,
      tier: input.tier,
      decisionId: id,
    });
    return id;
  })();

  // Index cleanup runs after both, best-effort, and never fails the merge. It sits outside the
  // transaction because it is asynchronous and a SQLite transaction cannot span an await.
  let vectorCleanupDeferred = false;
  try {
    await clearEntityVectors(deps.driver, mergedIds);
  } catch (err) {
    vectorCleanupDeferred = true;
    deps.logger.warn(
      { err, canonicalId: input.canonical.id, mergedIds },
      'entity merge vector cleanup deferred',
    );
  }

  return {
    status: 'merged',
    mergedIds,
    decisionId,
    edgesRedirected: merged.edgesRedirected,
    vectorCleanupDeferred,
  };
}
