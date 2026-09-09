import { z } from 'zod';

import { certifyNodeSupport } from '../../../evidence/application/node-support.js';
import { forgetOrphanNodeInTransaction } from '../../../infrastructure/graph/topology-queries.js';
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
import { pendingProposals, qualificationEvidence, qualificationHolds } from '../orphan-census.js';

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

const Payload = z.strictObject({
  nodeId: z.string().min(1),
  /** The policy the qualification window ran under. A different one is a different rule. */
  policyRevision: z.number().int().nonnegative(),
  /** The maturity bound the graph statement carries, so the write proves the age it rests on. */
  forgetBefore: z.string().min(1),
});

const Result = z.strictObject({ suppressed: z.boolean() });

type SuppressionData = z.infer<typeof Payload>;

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
  effectKinds: [ORPHAN_SUPPRESSION_EFFECT],
  payload: Payload,
  data: Payload,
  result: Result,
  prepare(context, payload) {
    const coverage = readCurrentCoverageContract(context.db);
    if (coverage === undefined) {
      throw new Error('an orphan suppression cannot publish before the coverage registry exists');
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
    const moved = qualificationStands(context, data);
    return Promise.resolve(
      moved === undefined
        ? ({ status: 'valid' } as const)
        : ({ status: 'deferred', reason: moved } as const),
    );
  },
  async applyGraph(context: PublicationContext, data: SuppressionData) {
    // The graph statement carries the orphan test and the maturity bound with it, so a node that
    // gained an association between the check and this write is not suppressed either.
    const suppressed = await forgetOrphanNodeInTransaction(context.graph, {
      id: data.nodeId,
      forgetBefore: new Date(data.forgetBefore),
      now: context.now,
    });
    return { suppressed };
  },
  prepareSqlite() {
    return undefined;
  },
  acknowledgeSqlite(context, data, result) {
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
