import { z } from 'zod';

import { durableEligibility, type EvictionCandidate } from './eviction-eligibility.js';
import { planRemoval } from './eviction-plan.js';
import { verifyEvidenceRevision } from '../../evidence/application/dependencies.js';
import { removeRawProjection } from '../../infrastructure/graph/episode-eviction.js';
import { PublicationOperation } from '../../infrastructure/publication/operation.js';
import { buildEvidenceRevision } from '../../infrastructure/publication/preconditions.js';
import type { PublicationContext } from '../../infrastructure/publication/types.js';
import {
  countSurvivorWorkOf,
  discardSurvivorWork,
  prepareSurvivorWork,
  releaseSurvivorWork,
  writeEvictionManifest,
} from '../../infrastructure/sqlite/eviction-manifests.js';
import {
  settleSourceResidency,
  transitionSourceResidency,
} from '../../infrastructure/sqlite/source-lifecycle.js';
import { IGNORED_FIELD_POLICY_REVISION } from '../domain/episode-eviction.js';

/**
 * The eviction operation, through the one coordinator every other writer publishes through.
 *
 * Nothing here is a second protocol. The guard, the durable intent, the receipt and the recovery
 * are A1's, the same six steps the chunk publication and the cutover take, and what this adds is
 * a handler whose graph effect happens to be a removal. That is deliberate: a destructive
 * operation with a lock of its own would be the one writer nobody else serializes against.
 *
 * The shape of the safety argument is the exact set. Nomination derives the removal set outside
 * the guard and pays for the hashes; `check` derives it again inside the guard and compares the
 * two as values, both directions, so anything that moved between them refuses the attempt rather
 * than shrinking or growing it. Counts are never the test — an equal-count replacement passes a
 * count and fails an identity — and the removal itself deletes enumerated relationships before
 * ordinary node deletes, so an edge nobody classified fails the transaction instead of vanishing
 * through a detach.
 *
 * What the operation owes the graph it leaves behind is durable before it removes anything: one
 * pinned task per affected survivor, written in the same preparation as the manifest and made
 * runnable only by the acknowledgment that a receipt proved. An attempt that never committed
 * leaves every one of them pinned, which is the honest state — no topology moved.
 */

export const EVICTION_EFFECT = 'episode_evicted';

const Dependency = z.strictObject({
  kind: z.enum(['source', 'node', 'relation_scope']),
  id: z.string().min(1),
  scope: z.string().min(1),
  version: z.string().min(1),
});

const Survivor = z.strictObject({
  nodeId: z.string().min(1),
  neighborhoodRevision: z.string().min(1),
});

const Payload = z.strictObject({
  sourceId: z.string().min(1),
  sessionId: z.string().min(1),
  observedAt: z.string().min(1),
  coverageEpoch: z.string().min(1),
  chunkId: z.string().min(1),
  publishedRevisionNo: z.number().int().nonnegative(),
  processingGeneration: z.number().int().positive(),
  operationalRevision: z.number().int().nonnegative(),
  readinessPolicyRevision: z.number().int().nonnegative(),
  projectionGeneration: z.number().int().positive(),
  /** The newest accepted reference batch the nomination read, bound as the source fence. */
  acceptedReferenceVersion: z.number().int().nonnegative(),
  qualifiedAt: z.string().min(1),
  /** The removal set as nomination bound it, outside the guard. */
  nodeIds: z.array(z.string().min(1)).min(1),
  relationIds: z.array(z.string().min(1)),
  nodeDigest: z.string().min(1),
  categoryDigest: z.string().min(1),
  survivors: z.array(Survivor),
  contentDigests: z.record(z.string(), z.string()),
  searchCoverageProof: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  dependencies: z.array(Dependency),
});

/**
 * The intent carries exactly what nomination bound and nothing derived under the guard. Every
 * guarded reading belongs to the recheck, which recovery runs again: a census serialized into the
 * intent would be the stale answer the comparison exists to catch.
 */
const Data = Payload;

const Result = z.strictObject({
  sourceId: z.string().min(1),
  removedNodes: z.number().int().nonnegative(),
  removedRelationships: z.number().int().nonnegative(),
  survivorTasks: z.number().int().nonnegative(),
});

type EvictionData = z.infer<typeof Data>;

function sortedKey(ids: readonly string[]): string {
  return JSON.stringify([...new Set(ids)].sort());
}

/** A digest map as one comparable value, key order removed. */
function digestKey(digests: Readonly<Record<string, string>>): string {
  return JSON.stringify(
    Object.keys(digests)
      .sort()
      .map((key) => [key, digests[key]]),
  );
}

/** The policy a recheck runs under: this attempt's own transition is not another writer's. */
function policyFor(data: EvictionData, operationId: string, now: Date) {
  return {
    now,
    // The age was proved at nomination and recorded in the intent. Re-testing it against the
    // clock here would refuse an attempt for taking longer than the window, which is backwards.
    minAgeMs: 0,
    resuming: { operationId, projectionGeneration: data.projectionGeneration },
  };
}

/**
 * Whether the candidate the records describe now is the one this intent was bound to.
 *
 * Each field is a different thing that can move underneath a prepared attempt: a new stage
 * obligation moves the operational revision, a republished chunk moves the head, a rebuild moves
 * the projection generation. None of them is caught by re-reading the graph, which is why the
 * durable half is compared field by field rather than trusted because the edges still match.
 */
function candidateMatches(data: EvictionData, candidate: EvictionCandidate): string | undefined {
  if (candidate.processingGeneration !== data.processingGeneration) {
    return 'processing_generation_changed';
  }
  if (candidate.operationalRevision !== data.operationalRevision) {
    return 'readiness_revision_changed';
  }
  if (
    candidate.publishedRevisionNo !== data.publishedRevisionNo ||
    candidate.chunkId !== data.chunkId
  ) {
    return 'chunk_head_changed';
  }
  if (candidate.projectionGeneration !== data.projectionGeneration) {
    return 'projection_generation_changed';
  }
  if (sortedKey([...candidate.turnIds, candidate.sourceId]) !== sortedKey(data.nodeIds)) {
    return 'source_parts_changed';
  }
  // The archive proof the manifest records. A guarded re-verification can rewrite a verified
  // content digest over an unchanged part set, and the manifest exists to prove exactly those
  // bytes: a digest bound at nomination and never reconfirmed would be a proof about an archive
  // reading nobody holds any more.
  if (digestKey(candidate.contentDigests) !== digestKey(data.contentDigests)) {
    return 'content_digests_changed';
  }
  // The source fence's third value. An acceptance that landed between nomination and the guard is
  // a statement about this source that the removal was not decided against.
  if (candidate.acceptedReferenceVersion !== data.acceptedReferenceVersion) {
    return 'reference_accepted';
  }
  return undefined;
}

/**
 * Everything the intent bound, derived again under the guard.
 *
 * The arming fence is part of it, so an operator stopping eviction reaches an attempt already
 * prepared: the recheck refuses it `compatibility_disarmed` and nothing is removed. What a stop
 * cannot reach is an attempt whose graph write already committed. That one finishes under the
 * guard it holds, because the removal happened and the acknowledgment is what records it.
 */
async function recheck(
  context: PublicationContext,
  data: EvictionData,
): Promise<string | undefined> {
  const verdict = durableEligibility(
    context.db,
    data.sourceId,
    policyFor(data, context.operationId, context.now),
  );
  if (verdict.status !== 'eligible') {
    return verdict.reason;
  }
  const drift = candidateMatches(data, verdict.candidate);
  if (drift !== undefined) {
    return drift;
  }
  // The four fixed source scopes this intent bound, checked rather than only carried. Content,
  // parts, state and references each move for their own reason, and a dependency set that is
  // written into an intent and never verified is a record of what was read rather than a fence.
  const revision = verifyEvidenceRevision(
    context.db,
    buildEvidenceRevision([...data.dependencies]),
  );
  if (revision.status !== 'current') {
    return `source_evidence_${revision.status}`;
  }
  const planned = await planRemoval(context.db, context.graph, verdict.candidate);
  if (planned.status !== 'planned') {
    return planned.reason;
  }
  if (planned.plan.nodeDigest !== data.nodeDigest) {
    return 'removal_nodes_moved';
  }
  if (planned.plan.categoryDigest !== data.categoryDigest) {
    return 'removal_categories_moved';
  }
  if (sortedKey(planned.plan.relationIds) !== sortedKey(data.relationIds)) {
    return 'incident_set_moved';
  }
  if (sortedKey(planned.plan.nodeIds) !== sortedKey(data.nodeIds)) {
    return 'removal_nodes_moved';
  }
  if (
    sortedKey(planned.plan.survivors.map((entry) => entry.nodeId)) !==
    sortedKey(data.survivors.map((entry) => entry.nodeId))
  ) {
    return 'survivor_population_moved';
  }
  return undefined;
}

/** The manifest row, assembled once so the durable record and the intent cannot disagree. */
function manifestOf(data: EvictionData, createdAt: string) {
  return {
    operationId: '',
    removalSetJson: JSON.stringify({
      sourceId: data.sourceId,
      sessionId: data.sessionId,
      nodeIds: data.nodeIds,
      chunkId: data.chunkId,
      publishedRevisionNo: data.publishedRevisionNo,
      qualifiedAt: data.qualifiedAt,
      ignoredFieldPolicyRevision: IGNORED_FIELD_POLICY_REVISION,
      searchCoverageProof: data.searchCoverageProof,
      nodeDigest: data.nodeDigest,
    }),
    contentDigestsJson: JSON.stringify(data.contentDigests),
    evidenceVersionsJson: JSON.stringify(data.dependencies),
    incidentEdgesJson: JSON.stringify({
      relationIds: data.relationIds,
      categoryDigest: data.categoryDigest,
    }),
    survivorObligationsJson: JSON.stringify(data.survivors),
    readinessPolicyRevision: data.readinessPolicyRevision,
    expectedOutcomeJson: JSON.stringify({
      nodes: data.nodeIds.length,
      relationships: data.relationIds.length,
      survivors: data.survivors.length,
      projectionGeneration: data.projectionGeneration,
      processingGeneration: data.processingGeneration,
    }),
    createdAt,
  };
}

export const episodeEvictionPublication = new PublicationOperation({
  kind: 'episode_eviction',
  effectKinds: [EVICTION_EFFECT],
  payload: Payload,
  data: Data,
  result: Result,
  prepare(_context, payload) {
    return Promise.resolve({
      data: payload,
      expected: {
        coverageEpoch: payload.coverageEpoch,
        evidence: buildEvidenceRevision([...payload.dependencies]),
        sources: [
          {
            sourceId: payload.sourceId,
            generation: String(payload.processingGeneration),
            acceptedReferenceVersion: String(payload.acceptedReferenceVersion),
          },
        ],
        heads: [{ chunkId: payload.chunkId, publishedRevisionNo: payload.publishedRevisionNo }],
      },
      scopes: [{ kind: 'source', id: payload.sourceId, scope: 'sqlite:source_residency' }],
      effects: [
        {
          kind: EVICTION_EFFECT,
          detail: {
            sourceId: payload.sourceId,
            nodes: payload.nodeIds.length,
            relationships: payload.relationIds.length,
          },
        },
      ],
    });
  },
  async check(context, data) {
    // Recovery replays this plan against a substrate that has had time to move, so the whole
    // fence runs here rather than at preparation: preparation's answer is about a moment that is
    // over by the time a resumed attempt reads it.
    const refusal = await recheck(context, data);
    return refusal === undefined ? { status: 'valid' } : { status: 'deferred', reason: refusal };
  },
  async applyGraph(context, data) {
    const outcome = await removeRawProjection(context.graph, {
      nodeIds: data.nodeIds,
      relationIds: data.relationIds,
    });
    if (
      sortedKey(outcome.nodes) !== sortedKey(data.nodeIds) ||
      sortedKey(outcome.relationships) !== sortedKey(data.relationIds)
    ) {
      throw new Error(`eviction of ${data.sourceId} removed a set it did not prepare`);
    }
    return {
      sourceId: data.sourceId,
      removedNodes: outcome.nodes.length,
      removedRelationships: outcome.relationships.length,
      // Read back from the records rather than counted off the plan. What the attempt asked for
      // and what it owns differ whenever a row was already runnable under an acknowledged
      // removal, and the result has to say what this attempt actually wrote.
      survivorTasks: countSurvivorWorkOf(context.db, context.operationId),
    };
  },
  prepareSqlite(context, data) {
    const manifest = manifestOf(data, data.observedAt);
    writeEvictionManifest(context.db, { ...manifest, operationId: context.operationId });
    const taken = transitionSourceResidency(context.db, {
      sourceId: data.sourceId,
      state: 'retiring',
      operationId: context.operationId,
      manifestDigest: data.categoryDigest,
      transitionedAt: new Date(data.observedAt),
    });
    if (taken !== data.projectionGeneration) {
      throw new Error(
        `eviction of ${data.sourceId} planned generation ${String(data.projectionGeneration)} and took ${String(taken)}`,
      );
    }
    // Pinned, and therefore owed and not runnable. The acknowledgment is what a committed receipt
    // buys them, so an attempt that dies here leaves work nobody can run on a topology nothing
    // changed. An obligation an earlier attempt wrote and could not release is re-adopted here
    // rather than left behind its rejected intent.
    prepareSurvivorWork(context.db, {
      operationId: context.operationId,
      sourceId: data.sourceId,
      processingGeneration: data.processingGeneration,
      obligations: data.survivors,
    });
    return undefined;
  },
  acknowledgeSqlite(context, data) {
    const settled = settleSourceResidency(context.db, {
      sourceId: data.sourceId,
      state: 'evicted',
      projectionGeneration: data.projectionGeneration,
      operationId: context.operationId,
      transitionedAt: new Date(context.knownFrom),
    });
    if (!settled) {
      throw new Error(`eviction of ${data.sourceId} was superseded before its acknowledgment`);
    }
    releaseSurvivorWork(context.db, context.operationId, new Date(context.observedAckAt));
    return undefined;
  },
  discardSqlite(context, data) {
    // Nothing was deleted, so the source goes back to resident under ANOTHER generation: the one
    // this attempt spent stays spent, and a late writer still holding it cannot land in the place
    // the next attempt will take.
    transitionSourceResidency(context.db, {
      sourceId: data.sourceId,
      state: 'resident',
      operationId: context.operationId,
      transitionedAt: new Date(data.observedAt),
    });
    // The obligations this attempt prepared are parked, not dropped and not left pinned. Nothing
    // was removed, so nothing is owed on the topology as it stands; the rows stay as the record
    // that the work was intended, and the next attempt re-adopts them under its own identity.
    discardSurvivorWork(context.db, context.operationId);
    return undefined;
  },
});
