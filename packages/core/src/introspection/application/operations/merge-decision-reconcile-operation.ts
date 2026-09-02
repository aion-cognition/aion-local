import {
  listMergeProvenance,
  type MergeProvenanceRecord,
} from '../../../infrastructure/graph/unmerge-queries.js';
import type { SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import {
  entityMergeDecisionKey,
  getEntityMergeDecisionByKey,
  recordEntityMergeDecision,
} from '../../../infrastructure/sqlite/entity-merge-decisions.js';
import { entityMergeLedgerKey } from '../../../reflection/domain/entity-merge.js';
import type { IntrospectionOperation, OperationOutcome } from '../../domain/operation.js';

/**
 * A merge lands in two stores. The graph commits first and carries the decision record's key in
 * its merge trail; the SQLite row that key names is written after. A process that dies in
 * between leaves the key pointing at nothing, and nothing replays it: every candidate read is
 * currency-filtered and the absorbed side is closed, so the pair can never form again. What a
 * person reversing that merge sees today is an unmerge reporting no decision at all.
 *
 * This walks the trail the graph does hold and writes the missing row back. The evidence the
 * cascade weighed is gone, so the row says so rather than naming a tier that decided nothing
 * anyone can read: what survives is which identities merged, when, and under which cascade.
 * That is enough for the unmerge to cite and for a later replay to find.
 */

export const MERGE_DECISION_RECONCILE_OPERATION = 'merge_decision_reconcile';

/**
 * Standing relevance, like `narrative_cleanup`: an orphaned key has no gauge in the snapshot
 * and should not get one, since counting them costs the same walk the repair itself does. It
 * reaches the urgency threshold on waiting time instead.
 */
export const MERGE_DECISION_RECONCILE_STANDING_RELEVANCE = 0.15;

/** What one absorbed group's records agree on: the decision they name and the members they cover. */
type OrphanedDecision = {
  readonly canonicalId: string;
  readonly decisionKey: string;
  readonly ledgerKey: string;
  readonly memberIds: readonly string[];
  readonly mergedAt: string;
};

function mergedAt(record: MergeProvenanceRecord): string | undefined {
  const stamp = record.raw.merged_at;
  return typeof stamp === 'string' ? stamp : undefined;
}

/**
 * The cascade version the merge ran under, recovered from its own ledger key and then proved by
 * rebuilding that key from it. Proving rather than parsing is what keeps a version containing
 * the separator from being read as a shorter one, and the version has to be exact: the decision
 * key is taken over it, so a guess writes a row under a key the graph does not point at.
 */
function cascadeVersionOf(orphan: OrphanedDecision): string | undefined {
  const candidate = orphan.ledgerKey.split(':')[1];
  if (candidate === undefined) {
    return undefined;
  }
  const rebuilt = entityMergeLedgerKey(candidate, orphan.canonicalId, orphan.memberIds);
  return rebuilt === orphan.ledgerKey ? candidate : undefined;
}

/**
 * The merge writes one record per absorbed identity and stamps all of them with the group's own
 * decision and ledger keys, so the group is reassembled by grouping on the decision key rather
 * than by trusting any single record to name every member.
 */
function orphanedDecisions(
  db: SqliteHandle,
  canonicalId: string,
  records: readonly MergeProvenanceRecord[],
): OrphanedDecision[] {
  const groups = new Map<string, { ledgerKey: string; members: string[]; mergedAt: string }>();
  for (const record of records) {
    const { decisionKey, ledgerKey } = record;
    if (decisionKey === undefined || ledgerKey === undefined) {
      continue;
    }
    if (getEntityMergeDecisionByKey(db, decisionKey) !== undefined) {
      continue;
    }
    const group = groups.get(decisionKey) ?? {
      ledgerKey,
      members: [],
      mergedAt: mergedAt(record) ?? '',
    };
    group.members.push(record.mergedId);
    groups.set(decisionKey, group);
  }

  return [...groups.entries()].map(([decisionKey, group]) => ({
    canonicalId,
    decisionKey,
    ledgerKey: group.ledgerKey,
    memberIds: [...new Set(group.members)].sort(),
    mergedAt: group.mergedAt,
  }));
}

/**
 * Written only when the recomputed key matches the one the graph points at. A row under any
 * other key would be a second decision record for one merge, which is the state this operation
 * exists to remove rather than one more of.
 */
function reconcile(db: SqliteHandle, orphan: OrphanedDecision, now: Date): boolean {
  const cascadeVersion = cascadeVersionOf(orphan);
  if (cascadeVersion === undefined) {
    return false;
  }
  if (
    entityMergeDecisionKey(orphan.canonicalId, orphan.memberIds, cascadeVersion) !==
    orphan.decisionKey
  ) {
    return false;
  }

  recordEntityMergeDecision(db, {
    canonicalId: orphan.canonicalId,
    memberIds: orphan.memberIds,
    tier: 'reconciled',
    reasons: ['the merge committed to the graph and its decision record never reached SQLite'],
    signals: [],
    cascadeVersion,
    createdAt: orphan.mergedAt === '' ? now.toISOString() : orphan.mergedAt,
  });
  return true;
}

export function mergeDecisionReconcileOperation(): IntrospectionOperation {
  return {
    name: MERGE_DECISION_RECONCILE_OPERATION,
    bucket: 'day',
    relevance: () => MERGE_DECISION_RECONCILE_STANDING_RELEVANCE,
    run: async (ctx): Promise<OperationOutcome> => {
      const canonicals = await listMergeProvenance(
        ctx.driver,
        ctx.config.maintenance.mergeDecisionReconcileBatch,
      );

      let orphans = 0;
      let written = 0;
      for (const canonical of canonicals) {
        if (ctx.signal.aborted) {
          break;
        }
        for (const orphan of orphanedDecisions(ctx.db, canonical.canonicalId, canonical.records)) {
          orphans += 1;
          if (reconcile(ctx.db, orphan, ctx.now)) {
            written += 1;
          }
        }
      }

      return {
        status: written === 0 ? 'noop' : 'applied',
        itemsProcessed: canonicals.length,
        itemsAffected: written,
        detail:
          `${String(orphans)} merges the graph states and SQLite does not, ` +
          `${String(written)} recorded back`,
      };
    },
  };
}
