import { z } from 'zod';

import { advanceNodeState } from '../../../evidence/application/node-state.js';
import { certifyNodeSupport } from '../../../evidence/application/node-support.js';
import { upsertEdgeInTransaction } from '../../../infrastructure/graph/edges.js';
import { NARRATIVE_LABEL } from '../../../infrastructure/graph/labels.js';
import {
  currentRetainedNodesInTransaction,
  forgetOrphanNodeInTransaction,
  nodeAssociationHistoryInTransaction,
  nodeLabelsInTransaction,
  type RelinkKind,
} from '../../../infrastructure/graph/topology-queries.js';
import { PublicationOperation } from '../../../infrastructure/publication/operation.js';
import { buildEvidenceRevision } from '../../../infrastructure/publication/preconditions.js';
import type {
  PublicationContext,
  PublicationOutcome,
} from '../../../infrastructure/publication/types.js';
import { readCurrentCoverageContract } from '../../../infrastructure/sqlite/coverage-contract.js';
import {
  clearOrphanQualification,
  readOrphanObservation,
} from '../../../infrastructure/sqlite/orphan-observations.js';
import { readCurrentReadinessPolicy } from '../../../infrastructure/sqlite/readiness-policies.js';
import {
  certifiedRelinkTarget,
  proposalHistoryToken,
  proposalStanding,
  qualificationEvidence,
  qualificationHolds,
} from '../orphan-census.js';

/**
 * Suppressing one disconnected node, under the guard.
 *
 * A forget has no reopen path, so the decision cannot rest on a reading taken before the batch.
 * The census qualified the node; this re-derives the whole predicate inside the operation that
 * holds the guard and writes the suppression in the same transaction. A dependency that moved
 * between the two readings defers the operation rather than being written over: an evidence,
 * proposal or state change landing in that window is exactly what the fence exists for, and
 * rechecking a graph disconnection predicate alone does not fence any of it.
 */
export const ORPHAN_SUPPRESSION_EFFECT = 'orphan_suppression';
export const ORPHAN_RELINK_EFFECT = 'orphan_relink_edge';

export const ORPHAN_RELINK_PROVENANCE = 'introspection';
export const ORPHAN_RELINK_SIGNAL = 'orphan_relink';

/**
 * A repair edge states that two nodes sit under the same wiring, which is weaker than anything
 * reflection infers from content. It is written weak on purpose: it exists to give activation a
 * path, and the real association that arrives later outranks it.
 */
export const ORPHAN_RELINK_STRENGTH = 0.2;
export const ORPHAN_RELINK_CONFIDENCE = 0.4;

const RELINK_RATIONALE: Readonly<Record<RelinkKind, string>> = {
  shared_entity: 'reconnected through an entity its container mentions',
  same_container: 'reconnected to a sibling under the same container',
};

const SuppressPayload = z.strictObject({
  mode: z.literal('suppress').optional(),
  nodeId: z.string().min(1),
  /** The policy the qualification window ran under. A different one is a different rule. */
  policyRevision: z.number().int().nonnegative(),
  /** The maturity bound the graph statement carries, so the write proves the age it rests on. */
  forgetBefore: z.string().min(1),
});

const RelinkPayload = z.strictObject({
  mode: z.literal('relink'),
  orphanId: z.string().min(1),
  targetId: z.string().min(1),
  relinkKind: z.enum(['shared_entity', 'same_container']),
});

const Payload = z.union([SuppressPayload, RelinkPayload]);

const Result = z.strictObject({ suppressed: z.boolean(), relinked: z.boolean() });

type SuppressionData = z.infer<typeof SuppressPayload>;
type RepairData = z.infer<typeof Payload>;

function isRelink(data: RepairData): data is z.infer<typeof RelinkPayload> {
  return data.mode === 'relink';
}

/** What a caller needs to publish one suppression. An absent one declines rather than writing. */
export type TopologyPublisher = {
  publish(request: {
    readonly kind: 'topology_update';
    readonly operationId: string;
    readonly payload: unknown;
  }): Promise<PublicationOutcome>;
};

/** The operation identity one node's suppression takes, so a replay lands on its own receipt. */
export function orphanSuppressionOperationId(nodeId: string, at: Date): string {
  return `orphan-suppression:${nodeId}:${at.toISOString()}`;
}

/** The same for one repair edge. The pair is the identity: one edge, one receipt. */
export function orphanRelinkOperationId(orphanId: string, targetId: string, at: Date): string {
  return `orphan-relink:${orphanId}:${targetId}:${at.toISOString()}`;
}

/**
 * Whether the pair the census certified still certifies, derived again under the guard.
 *
 * Both halves of the claim, because a repair edge asserts both: that these two nodes are eligible
 * retained interpretations still there to be related, and that a committed source still stands
 * behind each of them. Between the nomination and the write a source can close its incidence on
 * either end, and either endpoint can be forgotten or closed outright. The eligibility is checked
 * here rather than trusted from the plan, because a stale plan and a caller supplying its own
 * pair both reach this line: a raw container is not a repair subject wherever the pair came from.
 */
async function relinkStands(
  context: PublicationContext,
  data: z.infer<typeof RelinkPayload>,
): Promise<string | undefined> {
  const current = await currentRetainedNodesInTransaction(context.graph, [
    data.orphanId,
    data.targetId,
  ]);
  if (!current.has(data.orphanId) || !current.has(data.targetId)) {
    return 'relink_endpoint_not_eligible';
  }
  return certifiedRelinkTarget(context.db, data.orphanId, {
    orphanId: data.orphanId,
    targetId: data.targetId,
    kind: data.relinkKind,
  }) === undefined
    ? 'relink_proof_moved'
    : undefined;
}

/**
 * Whether the qualification the census recorded still holds, derived again from the records.
 *
 * Everything the window rested on: the policy it ran under, the support reading, the proposals
 * holding the node up, the node's own state, and the association history behind the disconnection
 * the census read. The whole dependency set, because a window is a claim about an interval and
 * checking the present tense of one dependency certifies nothing about the rest of it.
 * Unavailable proof holds the candidate, which is the only honest answer when a suppression
 * cannot be taken back.
 */
async function qualificationStands(
  context: PublicationContext,
  data: SuppressionData,
): Promise<string | undefined> {
  const observation = readOrphanObservation(context.db, data.nodeId);
  if (observation?.disposition !== 'unsupported') {
    return 'qualification_absent';
  }
  if (observation.policyRevision !== data.policyRevision) {
    return 'policy_revision_moved';
  }
  if (
    observation.policyRevision !== (readCurrentReadinessPolicy(context.db)?.policyRevision ?? 0)
  ) {
    return 'policy_revision_moved';
  }
  // Re-read under the guard rather than carried from the census: a node relabelled since would
  // otherwise be suppressed as what it used to be.
  const labels = (await nodeLabelsInTransaction(context.graph, [data.nodeId])).get(data.nodeId);
  if (labels === undefined) {
    return 'node_absent';
  }
  const reading = certifyNodeSupport(context.db, data.nodeId, {
    narrative: labels.includes(NARRATIVE_LABEL),
  });
  const standing = proposalStanding(context.db, data.nodeId);
  if (reading.support !== 'unsupported') {
    return 'support_moved';
  }
  if (standing.pending > 0) {
    return 'judgment_pending';
  }
  // Read under the guard, from the graph that owns it. A node the transaction cannot find has no
  // history to compare, and a suppression has no reopen path to correct that with later.
  const associations = (
    await nodeAssociationHistoryInTransaction(context.graph, [data.nodeId])
  ).get(data.nodeId);
  if (associations === undefined) {
    return 'association_history_unknown';
  }
  if (
    !qualificationHolds(
      observation.evidenceRevision,
      qualificationEvidence(context.db, data.nodeId, reading.evidenceRevision, {
        proposals: proposalHistoryToken(standing),
        associations,
      }),
    )
  ) {
    return 'evidence_moved';
  }
  if (new Date(observation.firstVerifiedAt).getTime() > new Date(data.forgetBefore).getTime()) {
    return 'qualification_not_mature';
  }
  return undefined;
}

export const orphanSuppressionPublication = new PublicationOperation({
  kind: 'topology_update',
  effectKinds: [ORPHAN_SUPPRESSION_EFFECT, ORPHAN_RELINK_EFFECT],
  payload: Payload,
  data: Payload,
  result: Result,
  prepare(context, payload) {
    const coverage = readCurrentCoverageContract(context.db);
    if (coverage === undefined) {
      throw new Error('an orphan repair cannot publish before the coverage registry exists');
    }
    if (isRelink(payload)) {
      // The certification is re-derived in `check` under the guard; what the plan carries is the
      // pair it is about, so a replay writes the edge the decision named and no other.
      return Promise.resolve({
        data: payload,
        expected: {
          coverageEpoch: coverage.epoch,
          evidence: buildEvidenceRevision([]),
          sources: [],
          heads: [],
        },
        scopes: [],
        effects: [
          {
            kind: ORPHAN_RELINK_EFFECT,
            detail: { orphanId: payload.orphanId, targetId: payload.targetId },
          },
        ],
      });
    }
    const observation = readOrphanObservation(context.db, payload.nodeId);
    return Promise.resolve({
      data: payload,
      expected: {
        coverageEpoch: coverage.epoch,
        // Every scope the qualification named, at the version it named, so the guard refuses a
        // suppression whose evidence moved rather than the caller noticing afterwards.
        evidence: buildEvidenceRevision(
          Object.entries(observation?.evidenceRevision ?? {}).map(([scope, version]) => ({
            kind: 'node' as const,
            id: payload.nodeId,
            scope,
            version,
          })),
        ),
        sources: [],
        heads: [],
      },
      scopes: Object.keys(observation?.evidenceRevision ?? {}).map((scope) => ({
        kind: 'node' as const,
        id: payload.nodeId,
        scope,
      })),
      effects: [{ kind: ORPHAN_SUPPRESSION_EFFECT, detail: { nodeId: payload.nodeId } }],
    });
  },
  async check(context, data) {
    if (isRelink(data)) {
      const withdrawn = await relinkStands(context, data);
      return withdrawn === undefined
        ? ({ status: 'valid' } as const)
        : ({ status: 'deferred', reason: withdrawn } as const);
    }
    const moved = await qualificationStands(context, data);
    return moved === undefined
      ? ({ status: 'valid' } as const)
      : ({ status: 'deferred', reason: moved } as const);
  },
  async applyGraph(context: PublicationContext, data: RepairData) {
    if (isRelink(data)) {
      await upsertEdgeInTransaction(context.graph, {
        type: 'RELATED_TO',
        sourceId: data.orphanId,
        targetId: data.targetId,
        strength: ORPHAN_RELINK_STRENGTH,
        confidence: ORPHAN_RELINK_CONFIDENCE,
        signals: [ORPHAN_RELINK_SIGNAL, data.relinkKind],
        provenance: [ORPHAN_RELINK_PROVENANCE],
        // A repair is a claim, not an observation, so a second run adds nothing to the count.
        count: 0,
        rationale: RELINK_RATIONALE[data.relinkKind],
        now: context.now,
      });
      return { suppressed: false, relinked: true };
    }
    // The graph statement carries the orphan test and the maturity bound with it, so a node that
    // gained an association between the check and this write is not suppressed either.
    const suppressed = await forgetOrphanNodeInTransaction(context.graph, {
      id: data.nodeId,
      forgetBefore: new Date(data.forgetBefore),
      now: context.now,
    });
    return { suppressed, relinked: false };
  },
  prepareSqlite() {
    return undefined;
  },
  acknowledgeSqlite(context, data, result) {
    if (isRelink(data)) {
      return undefined;
    }
    // The window is spent either way: a node this suppressed has no window left to run, and one
    // the graph refused was not the node the qualification described.
    if (result.suppressed) {
      clearOrphanQualification(context.db, data.nodeId);
      // A suppression is a change to the node's own semantic state, so the evidence somebody else
      // is holding about that state stops being current here, in the operation that made the
      // change. Left alone, a judgment fenced on the reading this operation invalidated would
      // still verify as current against a node that has been forgotten.
      advanceNodeState(context.db, data.nodeId, context.operationId, context.knownFrom);
    }
    return undefined;
  },
  discardSqlite() {
    // A refused suppression writes nothing and keeps the qualification: the next census reads the
    // dependency that moved and decides again.
    return undefined;
  },
});
