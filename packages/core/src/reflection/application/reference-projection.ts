import type { ReferenceTargetPlan } from './reference-acceptance.js';
import { writeClaimProvenanceInTransaction } from '../../infrastructure/graph/claim-provenance-queries.js';
import type { GraphTransaction } from '../../infrastructure/graph/connection.js';
import { presentNodeIds } from '../../infrastructure/graph/projection-presence.js';

/**
 * The graph half of accepting a reference, split from the durable half at the 500-line cap.
 *
 * The seam is the one `reference-acceptance.ts` already states: nothing in the durable half
 * consults the graph, because a statement about an endpoint the graph no longer holds is exactly
 * what those records exist to keep. This is the one place that does consult it, and it decides
 * only which edges the accepted set can currently carry.
 */

export type ReferenceProjection = {
  readonly projectedEdges: number;
  readonly unresolved: number;
};

/**
 * The edges an accepted set can currently carry, written inside the caller's graph transaction.
 *
 * Presence is read here rather than taken from the plan: a plan prepared before an interruption
 * can name an endpoint that has since stopped being projected, and an edge written against it
 * would fail the whole publication instead of settling the statement.
 *
 * Both ends or no edge. An absent source cannot carry lineage, and rebuilding one to make a
 * reference writable is what the residency rules forbid. A statement whose edge cannot be
 * written is not lost: it is already durable against the original identity, and the acceptance
 * records say so.
 */
export async function projectAcceptedReferences(
  tx: GraphTransaction,
  sourceId: string,
  targets: readonly ReferenceTargetPlan[],
  now: Date,
): Promise<ReferenceProjection> {
  const unresolved = targets.filter((target) => target.targetClass === 'unresolved').length;
  if (targets.length === 0) {
    return { projectedEdges: 0, unresolved };
  }
  const present = await presentNodeIds(tx, [sourceId, ...targets.map((target) => target.id)]);
  const held = present.has(sourceId)
    ? new Set(targets.filter((target) => present.has(target.id)).map((target) => target.id))
    : new Set<string>();
  if (held.size === 0 && !(unresolved > 0 && present.has(sourceId))) {
    return { projectedEdges: 0, unresolved };
  }
  const writable = targets.filter((target) => held.has(target.id));
  await writeClaimProvenanceInTransaction(tx, {
    episodeId: sourceId,
    derivedFrom: writable.filter((t) => t.kind === 'derived_from').map((t) => t.id),
    corrects: writable.filter((t) => t.kind === 'corrects').map((t) => t.id),
    confirmations: writable
      .filter((t) => t.confirmation !== undefined)
      .map((t) => ({
        target: t.id,
        by: t.confirmation?.by ?? '',
        evidence: t.confirmation?.evidence ?? '',
        at: new Date(t.confirmation?.occurredAt ?? now.toISOString()),
      })),
    unresolved,
    now,
  });
  return { projectedEdges: held.size, unresolved };
}
