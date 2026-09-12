import type { Driver } from 'neo4j-driver';

import { BITEMPORAL_PROPERTIES } from './bitemporal.js';
import { runRead, type GraphStatement } from './connection.js';
import { ENTITY_MENTION_TYPE } from './entity-queries.js';
import { CONTAINMENT_TYPE, MEMORY_PROPERTIES } from './episodes.js';
import { BASE_NODE_LABEL, EXTRACTION_TYPE, MEMORY_LABEL } from './labels.js';
import { SUMMARIZED_BY_TYPE } from './narrative-queries.js';
import { readModeFragment, withCurrency } from './read-modes.js';
import { fromGraphVector, toGraphDateTime, type Row } from './values.js';
import type { NeighborContentVector } from '../../reflection/domain/context-vector.js';

/**
 * Reflection's last stage recomputes `context_vec` for every `:Memory` node this run's
 * enrichment touched. This module owns the three batched reads that find that set, close it
 * over the run's own edge writes, and read its neighborhood, plus the batched write that stores
 * the result; `reflection/domain/context-vector.ts` owns the weighted-mean itself.
 */

/** Declared by migration 001 `FOR (n:Memory)`, alongside `content_vec`; no writer has needed a shared name for it before this stage. */
export const CONTEXT_VECTOR_PROPERTY = 'context_vec';

/**
 * The episode itself, its turns, the entities it mentions, the cognitive nodes extracted
 * from it, and the narrative it was folded into: every `:Memory` category one reflection
 * run can touch. One `UNION`ed statement rather than five round trips; `UNION` (not `UNION
 * ALL`) also gives id deduplication for free, though no id should ever appear in two
 * branches. The same read-mode fragment, built once against a shared `n`, is spliced into
 * every branch so a forgotten row in any category is excluded the same way.
 */
function affectedNodesStatement(episodeId: string, reference?: Date): GraphStatement {
  const fragment = readModeFragment(withCurrency(reference), 'n', 'aff');
  const branch = (match: string): string =>
    [match, `WHERE ${fragment.where}`, 'RETURN n.id AS id'].join('\n');

  const cypher = [
    branch('MATCH (n:Episode { id: $episodeId })'),
    'UNION',
    branch(`MATCH (n:Turn)-[:${CONTAINMENT_TYPE}]->(:Episode { id: $episodeId })`),
    'UNION',
    branch(`MATCH (:Episode { id: $episodeId })-[:${ENTITY_MENTION_TYPE}]->(n:Entity)`),
    'UNION',
    branch(`MATCH (n)-[:${EXTRACTION_TYPE}]->(:Episode { id: $episodeId })`),
    'UNION',
    branch(`MATCH (:Episode { id: $episodeId })-[:${SUMMARIZED_BY_TYPE}]->(n:Narrative)`),
  ].join('\n');

  return { cypher, parameters: { episodeId, ...fragment.parameters } };
}

/** Undefined only when the episode itself is unreadable; an episode with nothing else attached still returns its own id. */
export async function findAffectedNodeIds(
  driver: Driver,
  episodeId: string,
  /** The clock currency is judged from; the wall clock when a caller holds none. */
  reference?: Date,
): Promise<string[]> {
  const rows = await runRead(
    driver,
    affectedNodesStatement(episodeId, reference),
    (row) => row.id as string,
  );
  return [...new Set(rows)];
}

/**
 * The other half of the affected set. An edge write moves the context of both its endpoints,
 * and the family above names only the episode's own nodes, so the far endpoint of an edge this
 * run wrote keeps a `context_vec` computed from a neighborhood it no longer has. This read
 * names those far endpoints, and the stage recomputes them in the same batch.
 *
 * The closure is bounded by `since` rather than taken over the whole one-hop neighborhood,
 * which is precision and not economy: a neighbor whose incident edges did not move still has a
 * correct context vector, and one unbounded hop off a hub entity would recompute hundreds of
 * nodes nothing changed. `r.updated_at` is the stamp a run's own edge writes move, which is all
 * this closure has to catch; the maintenance scan in `context-vector-sync.ts` reads the decay
 * and prune stamps too, because those move between runs and no reflection pass sees them.
 *
 * **`valid_until IS NULL` keeps that division honest, and it is load-bearing now that the
 * recomputation is destructive.** A run that CLOSES an edge — a supersession, a prune — also
 * moves its `updated_at`, so without the predicate the far endpoint of a closed edge entered
 * this population, and the guarded read excludes closed edges, so the node arrived with a
 * certified-empty neighbourhood and left with its context vector cleared. The node does need
 * recomputing, and the pass that owns it is the maintenance scan: `valid_until` is one of the
 * three movement stamps that scan reads, exactly because closures are not a reflection run's to
 * catch. The stage's closure is about the edges it wrote and left standing.
 *
 * `:Memory` is required of the far endpoint because that is what the write below matches on: a
 * backbone node with no vector index behind it is not a node this stage can store a context for.
 */
function edgeTouchedNeighborsStatement(
  nodeIds: readonly string[],
  since: Date,
  reference: Date,
): GraphStatement {
  const fragment = readModeFragment(withCurrency(reference), 'm', 'tch');
  const cypher = [
    'UNWIND $nodeIds AS nodeId',
    `MATCH (n:${BASE_NODE_LABEL} { id: nodeId })-[r]-(m:${BASE_NODE_LABEL}:${MEMORY_LABEL})`,
    `WHERE m.id <> nodeId AND r.updated_at >= $since`,
    `  AND r.${BITEMPORAL_PROPERTIES.validUntil} IS NULL AND ${fragment.where}`,
    'RETURN DISTINCT m.id AS id',
  ].join('\n');

  return {
    cypher,
    parameters: {
      nodeIds: [...new Set(nodeIds)],
      since: toGraphDateTime(since),
      ...fragment.parameters,
    },
  };
}

/**
 * Endpoints on the other side of an edge written at or after `since`. Ids already in `nodeIds`
 * come back among them, since most edges a run writes have both ends inside the family; the
 * caller folds the two sets together.
 */
export async function findEdgeTouchedNeighborIds(
  driver: Driver,
  nodeIds: readonly string[],
  /** The run's own clock, which is what its edge writes stamped `updated_at` with. */
  since: Date,
  /** The clock currency is judged from; `since` when a caller holds no other vantage point. */
  reference: Date = since,
): Promise<string[]> {
  if (nodeIds.length === 0) {
    return [];
  }
  const rows = await runRead(
    driver,
    edgeTouchedNeighborsStatement(nodeIds, since, reference),
    (row) => row.id as string,
  );
  return [...new Set(rows)];
}

/**
 * One row per (affected node, edge to a vectored neighbor): neighbors outside the affected
 * set included, since a node's context is its whole graph neighborhood, not just what this
 * episode touched. Undirected (`-[r]-`) because a neighborhood is not a direction; direction
 * is the relationship's own semantics, the same reasoning `adjacency.ts` documents for
 * spreading activation. A neighbor with no `content_vec` (a pending-vector marker, a
 * structural backbone node) contributes nothing and is filtered out here, before the vector
 * ever reaches the domain math.
 *
 * `r.valid_until IS NULL` drops an edge `edge_prune` closed, the same predicate `adjacency.ts`
 * carries: a closed edge would otherwise weight the stored context at the floor strength the
 * close was meant to retire.
 */
function neighborContentVectorsStatement(
  nodeIds: readonly string[],
  reference?: Date,
): GraphStatement {
  const fragment = readModeFragment(withCurrency(reference), 'm', 'nb');
  const cypher = [
    'UNWIND $nodeIds AS nodeId',
    `MATCH (n:${BASE_NODE_LABEL} { id: nodeId })-[r]-(m:${BASE_NODE_LABEL})`,
    `WHERE m.id <> nodeId AND m.${MEMORY_PROPERTIES.contentVector} IS NOT NULL`,
    `  AND r.${BITEMPORAL_PROPERTIES.validUntil} IS NULL AND ${fragment.where}`,
    'RETURN nodeId, m.id AS neighborId,',
    '       coalesce(r.strength, 1.0) AS strength,',
    `       m.${MEMORY_PROPERTIES.contentVector} AS vector`,
  ].join('\n');

  return { cypher, parameters: { nodeIds: [...new Set(nodeIds)], ...fragment.parameters } };
}

function readNeighborRow(row: Row): NeighborContentVector | undefined {
  const vector = fromGraphVector(row.vector);
  if (vector === undefined) {
    return undefined;
  }
  return {
    nodeId: row.nodeId as string,
    neighborId: row.neighborId as string,
    strength: row.strength as number,
    vector,
  };
}

export async function findNeighborContentVectors(
  driver: Driver,
  nodeIds: readonly string[],
  /** The clock currency is judged from; the wall clock when a caller holds none. */
  reference?: Date,
): Promise<NeighborContentVector[]> {
  if (nodeIds.length === 0) {
    return [];
  }
  const rows = await runRead(
    driver,
    neighborContentVectorsStatement(nodeIds, reference),
    readNeighborRow,
  );
  return rows.filter((row): row is NeighborContentVector => row !== undefined);
}

/**
 * This module writes nothing.
 *
 * It used to carry a `writeContextVectors` that set `context_vec` from the driver with no sync
 * stamp and no receipt — the third of three writers of one served property, and the only one
 * that left no trace a later pass could read. Every write of the property now goes through the
 * guarded `context_vector_sync` operation and lands in `context-vector-sync.ts`; what stays
 * here are the reads that nominate the population.
 */
