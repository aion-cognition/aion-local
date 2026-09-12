import type { Driver } from 'neo4j-driver';
import { randomUUID } from 'node:crypto';

import {
  ABSENT_AT_BINDING,
  contextVectorSyncPublication,
  type ContextVectorBasis,
  type ContextVectorSyncResult,
} from './context-vector-sync.js';
import { readNeighborhoodRevisionsOf } from '../../infrastructure/graph/episode-eviction.js';
import type { PublicationCoordinator } from '../../infrastructure/publication/coordinator.js';
import { readCurrentCoverageContract } from '../../infrastructure/sqlite/coverage-contract.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';

export type { ContextVectorSyncResult };

/**
 * The one way into `context_vector_sync`, for all three passes that recompute the property.
 *
 * Lifted out of the operation module unchanged when that file reached the 500-line cap. The
 * split is also the right seam: this side runs BEFORE any guard is held and its whole job is to
 * bind what the guard will compare, while the operation is what the guard runs.
 */

export type ContextVectorMember = {
  readonly id: string;
  /** The obligation this member discharges, where the pass holds one. */
  readonly workId: string | null;
};

export type ContextVectorDemand = {
  readonly basis: ContextVectorBasis;
  readonly subject: string | null;
  readonly members: readonly ContextVectorMember[];
};

export type ContextVectorSyncDeps = {
  readonly driver: Driver;
  readonly db: SqliteHandle;
  readonly publications: PublicationCoordinator;
  readonly now: Date;
};

export type ContextVectorSyncOutcome =
  | {
      readonly status: 'published';
      readonly operationId: string;
      readonly result: ContextVectorSyncResult;
    }
  | { readonly status: 'refused'; readonly reason: string };

/**
 * The one entry point all three passes take.
 *
 * It binds what the guard will compare — the epoch, the member set, each member's neighbourhood
 * revision — before it asks for the guard, because that is the only order in which the
 * comparison means anything. A pass that read its population and then let the operation
 * re-derive it under the lock would be asking the guard to agree with itself.
 *
 * A refusal is named and returned, never thrown: every caller here is a maintenance pass whose
 * own report is where an operator will look, and the passes have no better answer to an
 * unavailable guard than to say so and come back next tick.
 */
export async function publishContextVectorSync(
  deps: ContextVectorSyncDeps,
  demand: ContextVectorDemand,
): Promise<ContextVectorSyncOutcome> {
  const members = new Map(demand.members.map((member) => [member.id, member] as const));
  const ids = [...members.keys()].sort();
  if (ids.length === 0) {
    return { status: 'refused', reason: 'no_member_nominated' };
  }
  const coverage = readCurrentCoverageContract(deps.db);
  if (coverage === undefined) {
    return { status: 'refused', reason: 'coverage_registry_missing' };
  }
  const revisions = await readNeighborhoodRevisionsOf(deps.driver, ids);
  const operationId = randomUUID();
  const outcome = await deps.publications.publish({
    kind: contextVectorSyncPublication.kind,
    operationId,
    payload: {
      basis: demand.basis,
      subject: demand.subject,
      observedAt: deps.now.toISOString(),
      coverageEpoch: coverage.epoch,
      nodes: ids.map((id) => ({
        id,
        neighborhoodRevision: revisions.get(id) ?? ABSENT_AT_BINDING,
        workId: members.get(id)?.workId ?? null,
      })),
    },
  });
  if (outcome.status !== 'acknowledged') {
    return { status: 'refused', reason: outcome.reason };
  }
  return {
    status: 'published',
    operationId,
    result: contextVectorSyncPublication.decodeResult(outcome.result),
  };
}
