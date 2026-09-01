import type { Driver } from 'neo4j-driver';

import {
  clearEntityVectors,
  redirectAndAbsorb,
  type DedupEntityDetail,
} from '../../infrastructure/graph/entity-dedup-queries.js';
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
 * ever claims a merge that did not happen; the ledger mark lands after the record, so a crash
 * between them replays into an idempotent re-record rather than losing the evidence.
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
  readonly now: Date;
};

export type EntityMergeWriteResult =
  | {
      readonly status: 'merged';
      readonly mergedIds: readonly string[];
      readonly decisionId: string;
      readonly edgesRedirected: number;
    }
  | { readonly status: 'skipped'; readonly reason: 'already_applied' | 'nothing_to_merge' };

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
      sharedEpisodeCount: pair?.sharedEpisodeCount ?? 0,
      sharedEpisodeJaccard: pair?.sharedEpisodeJaccard ?? 0,
      neighborOverlapCount: pair?.neighborOverlapCount ?? 0,
      neighborOverlapJaccard: pair?.neighborOverlapJaccard ?? 0,
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
  const absorbed = input.members.filter((member) => member.id !== input.canonical.id);
  const mergedIds = [...new Set(absorbed.map((member) => member.id))].sort();
  if (mergedIds.length === 0) {
    return { status: 'skipped', reason: 'nothing_to_merge' };
  }

  const ledgerKey = entityMergeLedgerKey(input.canonical.id, mergedIds);
  if (isLedgerApplied(deps.db, ledgerKey)) {
    return { status: 'skipped', reason: 'already_applied' };
  }
  const decisionKey = entityMergeDecisionKey(input.canonical.id, mergedIds, ENTITY_CASCADE_VERSION);

  const merged = await redirectAndAbsorb(deps.driver, {
    canonicalId: input.canonical.id,
    canonicalNameNorm: input.canonical.nameNorm,
    mergedIds,
    aliases: mergeAliases(input.canonical.name, input.members),
    accessCount: mergeAccessCount(input.members),
    lastAccessed: mergeLastAccessed(input.members),
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

  const decisionId = recordEntityMergeDecision(deps.db, {
    canonicalId: input.canonical.id,
    memberIds: mergedIds,
    tier: input.tier,
    reasons: input.reasons,
    signals: input.signals,
    ...(input.judge === undefined ? {} : { judge: input.judge }),
    cascadeVersion: ENTITY_CASCADE_VERSION,
    createdAt: input.now.toISOString(),
  });

  // Index cleanup runs post-commit with best-effort semantics and never fails the merge.
  try {
    await clearEntityVectors(deps.driver, mergedIds);
  } catch (err) {
    deps.logger.warn(
      { err, canonicalId: input.canonical.id, mergedIds },
      'entity merge vector cleanup deferred',
    );
  }

  markLedgerApplied(deps.db, ledgerKey, {
    canonicalId: input.canonical.id,
    mergedIds,
    tier: input.tier,
    decisionId,
  });

  return {
    status: 'merged',
    mergedIds,
    decisionId,
    edgesRedirected: merged.edgesRedirected,
  };
}
