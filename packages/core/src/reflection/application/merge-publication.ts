import { z } from 'zod';

import {
  acknowledgeEvidenceRecords,
  discardEvidenceRecords,
  prepareEvidenceRecords,
  type EvidenceLinkRecord,
} from './evidence-records.js';
import { verifyEvidenceRevision } from '../../evidence/application/dependencies.js';
import { ownershipIncidence, ownershipSummaryFor } from '../../evidence/application/ownership.js';
import { ownershipEvidenceVersion } from '../../evidence/domain/ownership.js';
import { bothEndpoints, nodeRoleScope, type DurableRole } from '../../evidence/domain/scopes.js';
import { mergeClaimPairInTransaction } from '../../infrastructure/graph/claim-dedup-queries.js';
import { projectOwnershipSummary } from '../../infrastructure/graph/ownership-summary-queries.js';
import { PublicationOperation } from '../../infrastructure/publication/operation.js';
import { buildEvidenceRevision } from '../../infrastructure/publication/preconditions.js';
import type { PublicationContext } from '../../infrastructure/publication/types.js';
import { committedIncidenceForNodesAt } from '../../infrastructure/sqlite/committed-evidence.js';
import { readCurrentCoverageContract } from '../../infrastructure/sqlite/coverage-contract.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { prepareRetirementVersion } from '../../infrastructure/sqlite/evidence-link-materialization.js';
import { releasePreparedLinkVersions } from '../../infrastructure/sqlite/evidence-link-settlement.js';
import { evidenceLinkId } from '../../infrastructure/sqlite/evidence-links.js';
import { readSubstratePairing } from '../../infrastructure/sqlite/publication-control.js';
import { commitSourceIncidence } from '../../infrastructure/sqlite/source-incidence.js';
import { checkPresentCoverage } from '../../recall/application/coverage-checker.js';

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

/** The revision the judge decided on, as its dependency set. The digest is recomputed here. */
const Revision = z.strictObject({
  contractVersion: z.literal(1),
  dependencies: z.array(
    z.strictObject({
      kind: z.enum(['source', 'node', 'relation_scope']),
      id: z.string().min(1),
      scope: z.string().min(1),
      version: z.string().min(1),
    }),
  ),
  digest: z.string(),
});

const Payload = z.strictObject({
  survivorId: z.string().min(1),
  loserId: z.string().min(1),
  /**
   * The clock the write stamps with. Omitted by a caller that retries the same decision on a
   * later tick: a payload carrying a fresh wall clock under a stable operation id is identity
   * reuse, and the substrate's own acceptance clock is the honest stamp anyway.
   */
  now: z.string().min(1).optional(),
  /**
   * What the judge decided on. It travels with the decision rather than being re-read at prepare:
   * a fresh reading is what the guard is supposed to be comparing AGAINST, and taking it here
   * would compare the substrate with itself and call every stale decision current.
   */
  judged: Revision.optional(),
  /**
   * The coverage contract that judgment was made under, carried for the same reason.
   *
   * The dependency set says what the decision read; this says what it was allowed to read. An
   * activation between the judgment and this write replaces the contract without touching a single
   * dependency, so a write that sampled the epoch here would fence against the very change it is
   * supposed to notice.
   */
  coverageEpoch: z.string().min(1).optional(),
});

const Carried = z.strictObject({
  sourceId: z.string().min(1),
  role: z.string().min(1),
  linkId: z.string().min(1),
  /** The clocks the absorbed row recorded. They travel; a merge is not a new observation. */
  clocks: z.record(z.string(), z.string()),
});

const Data = Payload.extend({
  /** The clock the write stamps with, resolved once at prepare so a replay keeps it. */
  at: z.string().min(1),
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

function carriedLinks(data: MergeData): readonly EvidenceLinkRecord[] {
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
    // The absorbed row's own clocks. A merge moves where the evidence points, not when it was
    // observed, and re-stamping it here would date every carried mention to the merge.
    clocks: row.clocks,
    recorded: { absorbed_from: data.loserId },
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
    // Three endpoints, two roles: the merge moves an incidence from the loser to the survivor, so
    // both nodes carry the node end of it and the source behind them carries the other.
    for (const entry of [
      ...bothEndpoints(row.role, row.sourceId, data.survivorId),
      { endpointId: data.loserId, relationClass: nodeRoleScope(row.role) },
    ]) {
      scopes.set(`${entry.endpointId}\n${entry.relationClass}`, entry);
    }
  }
  return [...scopes.values()];
}

/** The version this operation appended to one link, for the projection that must point at it. */
function retirementVersion(
  db: SqliteHandle,
  linkId: string,
  operationId: string,
): number | undefined {
  const row = db
    .prepare(
      `SELECT MAX(version) AS n FROM evidence_link_versions
       WHERE link_id = ? AND operation_id = ? AND state = 'retired'`,
    )
    .get(linkId, operationId) as { n: number | null };
  return row.n ?? undefined;
}

/**
 * What the loser currently holds, with the clocks its version chain recorded.
 *
 * Read through the chain rather than off the projection row, because the projection carries the
 * role and the currency and none of the intervals the carried row has to keep.
 */
function loserIncidence(db: SqliteHandle, loserId: string): readonly z.infer<typeof Carried>[] {
  return committedIncidenceForNodesAt(db, [loserId], undefined)
    .filter((row) => row.currency === 'open' && isCarriedRole(row.role))
    .map((row) => ({
      sourceId: row.sourceId,
      role: row.role,
      linkId: row.linkId,
      clocks: {
        ...(row.validFrom === undefined ? {} : { valid_from: row.validFrom }),
        ...(row.validUntil === undefined ? {} : { valid_until: row.validUntil }),
        ...(row.txFrom === undefined ? {} : { tx_from: row.txFrom }),
        ...(row.txUntil === undefined ? {} : { tx_until: row.txUntil }),
        // The absorbed row's own last-written clock. A reader that decides on recency reads it,
        // and a survivor holding the evidence without it answers that question from nothing.
        ...(row.updatedAt === undefined ? {} : { updated_at: row.updatedAt }),
      },
    }));
}

/**
 * The survivor's ownership summary as it will stand once this merge lands.
 *
 * The committed view cannot see the rows this operation prepared, so the summary is derived from
 * both. The loser's rows are dropped from it here for the same reason: they are retired by this
 * operation and a summary that still counted them would say the absorbed claim's sources hold
 * something that no longer exists.
 */
async function projectMergedOwnership(context: PublicationContext, data: MergeData): Promise<void> {
  const pairing = readSubstratePairing(context.db);
  if (pairing === undefined || context.sequence === null) {
    throw new Error('the ownership projection needs a paired substrate and a sequence');
  }
  const check = checkPresentCoverage(context.db, context.now);
  if (check.status !== 'checked') {
    throw new Error(`the ownership projection cannot read under ${check.refusal.reason}`);
  }
  const merged = [...ownershipIncidence(context.db, [data.survivorId], check.context)];
  for (const row of data.carried) {
    if (!merged.some((held) => held.sourceId === row.sourceId && held.role === row.role)) {
      merged.push({
        sourceId: row.sourceId,
        nodeId: data.survivorId,
        role: row.role,
        currency: 'open',
        linkId: evidenceLinkId(row.role, 'retained_node', row.sourceId, data.survivorId),
        linkVersion: 1,
      });
    }
  }
  const summary = ownershipSummaryFor(context.db, data.survivorId, merged, check.context);
  await projectOwnershipSummary(context.graph, {
    nodeId: data.survivorId,
    sessions: summary.sessions,
    unknownAttribution: summary.unknownAttribution,
    censusEstablished: summary.censusEstablished,
    evidenceVersion: ownershipEvidenceVersion(summary),
    sequence: context.sequence,
    substrateId: pairing.substrateId,
  });
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
      at: payload.now ?? context.now.toISOString(),
      carried: [...loserIncidence(context.db, payload.loserId)],
    };
    return Promise.resolve({
      data,
      expected: {
        // The judgment's own epoch where it named one. The coordinator fences the write against
        // the contract now in force, which only means anything if what it compares is the contract
        // the decision was taken under.
        coverageEpoch: payload.coverageEpoch ?? coverage.epoch,
        evidence: buildEvidenceRevision(payload.judged?.dependencies ?? []),
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
  check(context, data, expected) {
    // A merge destroys one of the two claims it is about. The judgment that chose between them is
    // what makes that safe, and its binding is the only record of what that judgment read: with no
    // binding there is nothing to re-verify, and an empty dependency set verifies as current
    // against any substrate at all — which is a guard that passes precisely when it has nothing to
    // check. The pair keeps its owed work and waits for a decision somebody can point at.
    if (data.judged === undefined || data.judged.dependencies.length === 0) {
      return Promise.resolve({
        status: 'rejected',
        reason: 'merge_without_judged_evidence',
      } as const);
    }
    // Half a binding is not one. A decision that names what it read but not what it was allowed to
    // read leaves the epoch to be sampled here, which is the comparison that never fails.
    if (data.coverageEpoch === undefined) {
      return Promise.resolve({
        status: 'rejected',
        reason: 'merge_without_coverage_binding',
      } as const);
    }
    // Under the guard, against the evidence the judge actually decided on. Currency alone cannot
    // see a correction, a confirmation or a changed required source arriving while both claims
    // stayed current, and that is exactly the window between the last model answer and this write.
    const revision = verifyEvidenceRevision(context.db, expected.evidence);
    if (revision.status === 'current') {
      return Promise.resolve({ status: 'valid' } as const);
    }
    return Promise.resolve({
      status: 'deferred',
      reason: `judged_evidence_${revision.status}`,
    } as const);
  },
  async applyGraph(context, data) {
    const result = await mergeClaimPairInTransaction(context.graph, {
      survivorId: data.survivorId,
      loserId: data.loserId,
      now: new Date(data.at),
    });
    if (result.merged) {
      // The owner set moved, so the summary a nomination discounts on moves with it. Leaving it
      // is what lets a pre-limit read call a now-shared memory own-only.
      await projectMergedOwnership(context, data);
    }
    return result;
  },
  prepareSqlite(context, data) {
    prepareEvidenceRecords(context.db, {
      sourceId: data.survivorId,
      operationId: context.operationId,
      links: carriedLinks(data),
      scopes: carriedScopes(data),
      observedAt: new Date(data.at),
      // The graph phase can decline, and an acknowledged decline must leave the committed view
      // exactly as it found it. The projection is written in the acknowledgment instead.
      project: false,
    });
    // The retirement is a version of the loser's own link, prepared here and durable-but-invisible
    // like everything else this operation writes.
    for (const row of data.carried) {
      prepareRetirementVersion(context.db, {
        linkId: row.linkId,
        operationId: context.operationId,
        operationKey: `merge-retire:${context.operationId}:${row.linkId}`,
        recordedValues: { ...row.clocks, currency: 'closed', absorbed_into: data.survivorId },
        temporalProof: { basis: 'claim_merge', ...row.clocks },
        observedAt: new Date(data.at),
      });
    }
    return undefined;
  },
  acknowledgeSqlite(context, data, result) {
    // A write the graph declined changed nothing there and must change nothing here. The numbers
    // this operation parked go back, so the tokens a reader already holds stay current, and the
    // versions it prepared are released rather than left owed.
    //
    // Left, they would be owed forever: this operation is acknowledged, so no recovery revisits
    // it, and its versions are keyed on its own id, so no later merge can find them. The eviction
    // fence reads any unacknowledged version as an obligation and would pin every source behind
    // the absorbed claim on one no repair could discharge.
    if (!result.merged) {
      releasePreparedLinkVersions(context.db, context.operationId);
      discardEvidenceRecords(context.db, {
        sourceId: data.survivorId,
        operationId: context.operationId,
        scopes: carriedScopes(data),
        observedAt: new Date(data.at),
      });
      return undefined;
    }
    acknowledgeEvidenceRecords(
      context.db,
      {
        sourceId: data.survivorId,
        operationId: context.operationId,
        links: carriedLinks(data),
        scopes: carriedScopes(data),
        observedAt: new Date(data.at),
      },
      context.knownFrom,
      context.observedAckAt,
    );
    for (const row of data.carried) {
      const retired = retirementVersion(context.db, row.linkId, context.operationId);
      if (retired === undefined) {
        continue;
      }
      // The projection follows the chain: it points at the version that retired it, so a
      // historical read and a present one give the same answer about the same row.
      commitSourceIncidence(context.db, {
        sourceId: row.sourceId,
        nodeId: data.loserId,
        role: row.role,
        linkId: row.linkId,
        linkVersion: retired,
        currency: 'closed',
        clocks: row.clocks,
      });
    }
    return undefined;
  },
  discardSqlite(context, data) {
    // Same release on the rejected path. A discard is terminal for the operation, so a version it
    // prepared under its own key has no later attempt that could adopt or settle it.
    releasePreparedLinkVersions(context.db, context.operationId);
    discardEvidenceRecords(context.db, {
      sourceId: data.survivorId,
      operationId: context.operationId,
      scopes: carriedScopes(data),
      observedAt: new Date(data.at),
    });
    return undefined;
  },
});
