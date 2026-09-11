import { incidenceProves, type EvictionCandidate } from './eviction-eligibility.js';
import type { GraphTransaction } from '../../infrastructure/graph/connection.js';
import {
  readIncidentEdges,
  readNeighborhoodRevisions,
  readProjectedTurnIds,
  readRemovalNodes,
} from '../../infrastructure/graph/episode-eviction.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import type { SurvivorObligation } from '../../infrastructure/sqlite/eviction-manifests.js';
import {
  classifyRemovalSet,
  EVICTION_BOUNDS,
  nodeSetDigest,
  removalSetBound,
  sortedIdentities,
  type ClassifiedEdge,
} from '../domain/episode-eviction.js';

/**
 * The exact set one attempt would remove, derived from the graph rather than assumed from the
 * records.
 *
 * The same function runs twice on different sides of the guard: once outside it to nominate a
 * candidate and pay for the hashes, and once inside it against a fresh reading. Two readings of
 * one derivation is what makes the comparison meaningful — a second derivation could differ for
 * reasons that have nothing to do with the graph moving.
 *
 * Everything it can refuse, it refuses by name. A projection whose parts are not all there, a
 * Turn claiming this Episode that the part records never captured, an incident census that filled
 * its page, an edge category nobody classified, a preserved role with no durable row behind it:
 * each of those pins the source and none of them is a smaller removal set.
 */

export type PlannedRemoval = {
  readonly nodeIds: readonly string[];
  readonly nodeDigest: string;
  readonly edges: readonly ClassifiedEdge[];
  readonly relationIds: readonly string[];
  readonly categoryDigest: string;
  readonly survivors: readonly SurvivorObligation[];
  readonly disposable: number;
  readonly preserved: number;
};

export type RemovalPlanResult =
  | { readonly status: 'planned'; readonly plan: PlannedRemoval }
  | { readonly status: 'pinned'; readonly reason: string };

function pinned(reason: string): RemovalPlanResult {
  return { status: 'pinned', reason };
}

function carries(labels: readonly string[], label: string): boolean {
  return labels.includes(label);
}

export async function planRemoval(
  db: SqliteHandle,
  graph: GraphTransaction,
  candidate: EvictionCandidate,
): Promise<RemovalPlanResult> {
  const nodeIds = sortedIdentities([candidate.sourceId, ...candidate.turnIds]);
  const bound = removalSetBound(nodeIds.length, 0);
  if (bound !== undefined) {
    return pinned(bound);
  }
  const nodes = await readRemovalNodes(graph, nodeIds);
  if (nodes.length !== nodeIds.length) {
    return pinned('projection_incomplete');
  }
  for (const node of nodes) {
    const expected = node.id === candidate.sourceId ? 'Episode' : 'Turn';
    if (!carries(node.labels, expected)) {
      return pinned('removal_label_unexpected');
    }
    if (
      node.id === candidate.sourceId
        ? carries(node.labels, 'Turn')
        : carries(node.labels, 'Episode')
    ) {
      return pinned('removal_label_mixed');
    }
  }
  const projected = await readProjectedTurnIds(graph, candidate.sourceId, EVICTION_BOUNDS.nodes);
  const owned = new Set(candidate.turnIds);
  if (projected.length !== owned.size || projected.some((id) => !owned.has(id))) {
    return pinned('projected_turns_disagree');
  }
  const census = await readIncidentEdges(graph, nodeIds, EVICTION_BOUNDS.edges);
  if (census.overflowed) {
    return pinned('incident_census_bound');
  }
  const classification = classifyRemovalSet(census.edges);
  if (classification.status === 'blocked') {
    return pinned(classification.reason);
  }
  const proof = incidenceProves(db, candidate.sourceId, classification.required);
  if (proof.status === 'missing') {
    return pinned(proof.reason);
  }
  const relationIds = sortedIdentities(classification.edges.map((entry) => entry.edge.relationId));
  const edgeBound = removalSetBound(nodeIds.length, relationIds.length);
  if (edgeBound !== undefined) {
    return pinned(edgeBound);
  }
  const revisions = await readNeighborhoodRevisions(graph, classification.survivorIds);
  const survivors: SurvivorObligation[] = [];
  for (const nodeId of classification.survivorIds) {
    const revision = revisions.get(nodeId);
    if (revision === undefined) {
      // A neighbour that is not there is not a survivor, and a task bound to no reading could
      // never be retried against one.
      return pinned('survivor_unreadable');
    }
    survivors.push({ nodeId, neighborhoodRevision: revision });
  }
  return {
    status: 'planned',
    plan: {
      nodeIds,
      nodeDigest: nodeSetDigest(nodes),
      edges: classification.edges,
      relationIds,
      categoryDigest: classification.categoryDigest,
      survivors,
      disposable: classification.edges.filter(
        (entry) => entry.disposition.category === 'disposable_association',
      ).length,
      preserved: classification.edges.filter(
        (entry) => entry.disposition.category === 'preserved_evidence',
      ).length,
    },
  };
}
