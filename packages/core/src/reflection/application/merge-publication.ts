import { z } from 'zod';

import {
  acknowledgeMaterialization,
  discardMaterialization,
  prepareMaterialization,
  type PlannedLink,
} from './legacy-records.js';
import {
  durableRoleScope,
  nodeScopeDirection,
  type DurableRole,
} from '../../evidence/domain/scopes.js';
import { mergeClaimPairInTransaction } from '../../infrastructure/graph/claim-dedup-queries.js';
import { PublicationOperation } from '../../infrastructure/publication/operation.js';
import { buildEvidenceRevision } from '../../infrastructure/publication/preconditions.js';
import { committedIncidenceForNode } from '../../infrastructure/sqlite/committed-evidence.js';
import { readCurrentCoverageContract } from '../../infrastructure/sqlite/coverage-contract.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { evidenceLinkId } from '../../infrastructure/sqlite/evidence-links.js';
import { closeSourceIncidence } from '../../infrastructure/sqlite/source-incidence.js';

/**
 * A claim merge as a publication.
 *
 * The merge was a bare graph write, and that is what made its worst case unrecoverable: a commit
 * whose response was lost arrived as a driver error and was counted as a pair that never merged,
 * so the next run judged the same pair again against a graph where one side was already gone.
 * Under the coordinator the receipt says which way it went, and the batch reconciles instead of
 * guessing.
 *
 * It also carries the loser's evidence across. A merge that moved only the resident graph edges
 * would leave every source that stood behind the absorbed claim standing behind nothing: the
 * incidence rows are the record, so they are re-recorded against the survivor and the loser's are
 * RETIRED rather than deleted. A retired row is the evidence that the claim was there and was
 * absorbed, which a deletion would destroy.
 */
export const MERGE_EFFECT = 'claim_merge';

const Payload = z.strictObject({
  survivorId: z.string().min(1),
  loserId: z.string().min(1),
  now: z.string().min(1),
});

const Carried = z.strictObject({
  sourceId: z.string().min(1),
  role: z.string().min(1),
  linkId: z.string().min(1),
});

const Data = Payload.extend({
  /** The loser's committed incidence, as it stood when the plan was made. */
  carried: z.array(Carried),
});

const Result = z.strictObject({
  merged: z.boolean(),
  episodesFolded: z.number().int().nonnegative(),
});

type MergeData = z.infer<typeof Data>;

/** The roles a merge carries. Anything the registry does not name is left where it is. */
function isCarriedRole(role: string): role is DurableRole {
  return ['extraction', 'mention', 'participation', 'source_coverage'].includes(role);
}

function carriedLinks(data: MergeData): readonly PlannedLink[] {
  return data.carried.map((row) => ({
    linkId: evidenceLinkId(row.role, 'retained_node', row.sourceId, data.survivorId),
    kind: row.role,
    qualifier: 'retained_node',
    fromId: row.sourceId,
    toId: data.survivorId,
    // The identity the loser's own record carried, so the survivor's row says where it came from.
    relationId: row.linkId,
    relationType: 'CLAIM_MERGE',
    incident: true,
    closed: false,
    clocks: {},
  }));
}

function carriedScopes(
  data: MergeData,
): readonly { readonly endpointId: string; readonly relationClass: string }[] {
  const scopes = new Map<string, { endpointId: string; relationClass: string }>();
  for (const row of data.carried) {
    if (!isCarriedRole(row.role)) {
      continue;
    }
    const node = nodeScopeDirection(row.role);
    const source = node === 'in' ? 'out' : 'in';
    for (const entry of [
      { endpointId: data.survivorId, relationClass: durableRoleScope(row.role, node) },
      { endpointId: data.loserId, relationClass: durableRoleScope(row.role, node) },
      { endpointId: row.sourceId, relationClass: durableRoleScope(row.role, source) },
    ]) {
      scopes.set(`${entry.endpointId}\n${entry.relationClass}`, entry);
    }
  }
  return [...scopes.values()];
}

/** What the loser currently holds, in the shape the plan carries. */
function loserIncidence(db: SqliteHandle, loserId: string): readonly z.infer<typeof Carried>[] {
  return committedIncidenceForNode(db, loserId)
    .filter((row) => row.currency === 'open' && isCarriedRole(row.role))
    .map((row) => ({ sourceId: row.sourceId, role: row.role, linkId: row.linkId }));
}

export const claimMergePublication = new PublicationOperation({
  kind: 'semantic_write',
  effectKinds: [MERGE_EFFECT],
  payload: Payload,
  data: Data,
  result: Result,
  prepare(context, payload) {
    const coverage = readCurrentCoverageContract(context.db);
    if (coverage === undefined) {
      throw new Error('a merge cannot publish before the coverage registry exists');
    }
    const data: MergeData = {
      ...payload,
      carried: [...loserIncidence(context.db, payload.loserId)],
    };
    return Promise.resolve({
      data,
      expected: {
        coverageEpoch: coverage.epoch,
        evidence: buildEvidenceRevision([]),
        sources: [],
        heads: [],
      },
      scopes: carriedScopes(data).map((scope) => ({
        kind: 'relation_scope' as const,
        id: scope.endpointId,
        scope: scope.relationClass,
      })),
      effects: [{ kind: MERGE_EFFECT, detail: { survivor: payload.survivorId } }],
    });
  },
  check() {
    // The write re-reads both sides' currency inside its own transaction, and that reading is
    // the one that decides. A second check here would only widen the window it closes.
    return Promise.resolve({ status: 'valid' } as const);
  },
  async applyGraph(context, data) {
    return mergeClaimPairInTransaction(context.graph, {
      survivorId: data.survivorId,
      loserId: data.loserId,
      now: new Date(data.now),
    });
  },
  prepareSqlite(context, data) {
    prepareMaterialization(context.db, {
      sourceId: data.survivorId,
      operationId: context.operationId,
      links: carriedLinks(data),
      scopes: carriedScopes(data),
      observedAt: new Date(data.now),
    });
    return undefined;
  },
  acknowledgeSqlite(context, data, result) {
    acknowledgeMaterialization(
      context.db,
      {
        sourceId: data.survivorId,
        operationId: context.operationId,
        scopes: carriedScopes(data),
        observedAt: new Date(data.now),
      },
      context.knownFrom,
      context.observedAckAt,
    );
    // Only a merge that happened retires the loser's rows. A write that found one side already
    // stale changed nothing in the graph and must change nothing here either.
    if (!result.merged) {
      return undefined;
    }
    for (const row of data.carried) {
      closeSourceIncidence(context.db, {
        sourceId: row.sourceId,
        nodeId: data.loserId,
        role: row.role,
      });
    }
    return undefined;
  },
  discardSqlite(context, data) {
    discardMaterialization(context.db, {
      sourceId: data.survivorId,
      operationId: context.operationId,
      scopes: carriedScopes(data),
      observedAt: new Date(data.now),
    });
    return undefined;
  },
});
