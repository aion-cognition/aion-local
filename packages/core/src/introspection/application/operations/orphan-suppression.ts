import { z } from 'zod';

import { certifyNodeSupport } from '../../../evidence/application/node-support.js';
import { upsertEdgeInTransaction } from '../../../infrastructure/graph/edges.js';
import {
  forgetOrphanNodeInTransaction,
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
  pendingProposals,
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
 * The certification is a present-tense claim about two nodes, and a repair edge is a
 * present-tense write. Between the read and the write a source can close its incidence on either
 * end, and an edge written out of a relationship somebody ended is exactly what the proof is
 * supposed to prevent.
 */
function relinkStands(context: PublicationContext, data: z.infer<typeof RelinkPayload>): boolean {
  return (
    certifiedRelinkTarget(context.db, data.orphanId, {
      orphanId: data.orphanId,
      targetId: data.targetId,
      kind: data.relinkKind,
    }) !== undefined
  );
}

/**
 * Whether the qualification the census recorded still holds, derived again from the records.
 *
 * Everything the window rested on: the policy it ran under, the support reading, the proposals
 * holding the node up, and the recorded dependency set. Unavailable proof holds the candidate,
 * which is the only honest answer when a suppression cannot be taken back.
 */
function qualificationStands(
  context: PublicationContext,
  data: SuppressionData,
): string | undefined {
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
  const reading = certifyNodeSupport(context.db, data.nodeId);
  const pending = pendingProposals(context.db, data.nodeId);
  if (reading.support !== 'unsupported') {
    return 'support_moved';
  }
  if (pending > 0) {
    return 'judgment_pending';
  }
  if (
    !qualificationHolds(
      observation.evidenceRevision,
      qualificationEvidence(reading.evidenceRevision, pending),
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
  check(context, data) {
    if (isRelink(data)) {
      return Promise.resolve(
        relinkStands(context, data)
          ? ({ status: 'valid' } as const)
          : ({ status: 'deferred', reason: 'relink_proof_moved' } as const),
      );
    }
    const moved = qualificationStands(context, data);
    return Promise.resolve(
      moved === undefined
        ? ({ status: 'valid' } as const)
        : ({ status: 'deferred', reason: moved } as const),
    );
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
    }
    return undefined;
  },
  discardSqlite() {
    // A refused suppression writes nothing and keeps the qualification: the next census reads the
    // dependency that moved and decides again.
    return undefined;
  },
});
