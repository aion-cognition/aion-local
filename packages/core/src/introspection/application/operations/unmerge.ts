import type { Driver } from 'neo4j-driver';

import {
  applyUnmerge,
  readCanonicalMerge,
  readCanonicalMergeRecords,
  type MergeProvenanceRecord,
} from '../../../infrastructure/graph/unmerge-queries.js';
import type { Logger } from '../../../infrastructure/logging/logger.js';
import type { SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import { getEntityMergeDecisionByKey } from '../../../infrastructure/sqlite/entity-merge-decisions.js';
import { isLedgerApplied, markLedgerApplied } from '../../../infrastructure/sqlite/ops-ledger.js';

/**
 * Unmerge: split one absorbed identity back out of the entity it was merged into.
 *
 * This is deliberately NOT in the operation catalog and the introspector never selects it.
 * Every other maintenance operation repairs a pathology the substrate can measure. A bad
 * merge is not measurable from inside: the graph after a correct merge and the graph after a
 * wrong one are the same shape, and the only thing that separates them is a person saying the
 * two names were different things. An auto-selected unmerge would therefore have to guess
 * which merges were mistakes, and the cost of guessing wrong is the identity fragmentation
 * dedup exists to remove. So the repair is a callable operation with the same bounded,
 * idempotent, recorded shape as the rest, and a person or a command decides when it runs.
 *
 * It stays here, beside the catalog, because the introspector is where it belongs the day the
 * substrate can carry that judgment: a merge a person reversed is the evidence a future
 * effectiveness rule would learn from.
 */

export const ENTITY_UNMERGE_OPERATION = 'entity_unmerge';

export type UnmergeDeps = {
  readonly driver: Driver;
  readonly db: SqliteHandle;
  readonly logger: Logger;
};

export type UnmergeRequest = {
  /** The absorbed node's id, as the merge record names it. */
  readonly mergedId: string;
  readonly now?: Date;
};

/**
 * What the merge said it knew, for the person reversing it. Absent on a merge written before
 * the cascade recorded decisions, and on one whose record has since been cleared.
 */
export type UnmergedDecision = {
  readonly id: string;
  readonly tier: string;
  readonly reasons: readonly string[];
};

export type UnmergeReport = {
  readonly status: 'applied' | 'noop';
  readonly detail: string;
  readonly canonicalId?: string;
  /** The re-minted node carrying the split identity. */
  readonly restoredId?: string;
  readonly edgesRestored: number;
  /** Recorded edges whose other endpoint has since left the graph. */
  readonly edgesSkipped: number;
  readonly aliasesReleased: number;
  readonly decision?: UnmergedDecision;
};

/**
 * The merge stamps the decision record's idempotency key into its own provenance, so the
 * evidence is one lookup away rather than a key recomputed from a membership the graph no
 * longer states in one place.
 */
function decisionFor(
  db: SqliteHandle,
  record: MergeProvenanceRecord,
): UnmergedDecision | undefined {
  const key = record.raw.decision_key;
  if (typeof key !== 'string') {
    return undefined;
  }
  const decision = getEntityMergeDecisionByKey(db, key);
  if (decision === undefined) {
    return undefined;
  }
  return { id: decision.id, tier: decision.tier, reasons: decision.reasons };
}

/** Mirrors the merge's own key, so the two halves of one repair read as a pair in the ledger. */
export function entityUnmergeLedgerKey(canonicalId: string, mergedId: string): string {
  return `entity.unmerge:${canonicalId}:${mergedId}`;
}

function nothingToDo(detail: string, canonicalId?: string): UnmergeReport {
  return {
    status: 'noop',
    detail,
    ...(canonicalId === undefined ? {} : { canonicalId }),
    edgesRestored: 0,
    edgesSkipped: 0,
    aliasesReleased: 0,
  };
}

/**
 * What a canonical entity has absorbed, so a caller can show the choices before asking for
 * one. A record already carrying `unmergedAt` has been split back out and is history.
 */
export async function listUnmergeableRecords(
  driver: Driver,
  canonicalId: string,
): Promise<readonly MergeProvenanceRecord[]> {
  const canonical = await readCanonicalMergeRecords(driver, canonicalId);
  if (canonical === undefined) {
    return [];
  }
  return canonical.records.filter((record) => record.unmergedAt === undefined);
}

/**
 * Idempotent on the merge record itself, not only on the ledger: the record is the durable
 * statement that this identity has already come back, and it survives a data directory the
 * ledger does not.
 */
export async function runEntityUnmerge(
  deps: UnmergeDeps,
  request: UnmergeRequest,
): Promise<UnmergeReport> {
  const now = request.now ?? new Date();
  const canonical = await readCanonicalMerge(deps.driver, request.mergedId);
  if (canonical === undefined) {
    return nothingToDo('no merge record names this node');
  }

  const record = canonical.records.find((entry) => entry.mergedId === request.mergedId);
  if (record === undefined) {
    return nothingToDo('the canonical carries no record for this node', canonical.canonicalId);
  }
  if (record.unmergedAt !== undefined) {
    return nothingToDo('this identity has already been split back out', canonical.canonicalId);
  }
  if (record.mergedNameNorm === undefined || record.mergedType === undefined) {
    return nothingToDo(
      'the merge record predates identity capture and cannot be reversed',
      canonical.canonicalId,
    );
  }

  const key = entityUnmergeLedgerKey(canonical.canonicalId, request.mergedId);
  if (isLedgerApplied(deps.db, key)) {
    return nothingToDo('an earlier run already applied this unmerge', canonical.canonicalId);
  }

  const result = await applyUnmerge(deps.driver, {
    canonicalId: canonical.canonicalId,
    canonicalNameNorm: canonical.canonicalNameNorm,
    record,
    canonicalAliases: canonical.aliases,
    records: canonical.records,
    now,
  });

  markLedgerApplied(deps.db, key, {
    operation: ENTITY_UNMERGE_OPERATION,
    canonicalId: canonical.canonicalId,
    mergedId: request.mergedId,
    restoredId: result.restoredId,
    edgesRestored: result.edgesRestored,
    edgesSkipped: result.edgesSkipped,
  });
  deps.logger.info(
    {
      operation: ENTITY_UNMERGE_OPERATION,
      canonicalId: canonical.canonicalId,
      restoredId: result.restoredId,
      edgesRestored: result.edgesRestored,
      edgesSkipped: result.edgesSkipped,
    },
    'entity unmerge applied',
  );

  const decision = decisionFor(deps.db, record);
  return {
    status: 'applied',
    detail:
      `restored one identity with ${String(result.edgesRestored)} edges, ` +
      `${String(result.edgesSkipped)} skipped`,
    ...(decision === undefined ? {} : { decision }),
    canonicalId: canonical.canonicalId,
    restoredId: result.restoredId,
    edgesRestored: result.edgesRestored,
    edgesSkipped: result.edgesSkipped,
    aliasesReleased: result.aliasesReleased,
  };
}
