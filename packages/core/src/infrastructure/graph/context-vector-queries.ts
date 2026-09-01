import type { Driver } from 'neo4j-driver';

import { runRead, runWrite, type GraphStatement } from './connection.js';
import { ENTITY_MENTION_TYPE } from './entity-queries.js';
import { CONTAINMENT_TYPE, MEMORY_PROPERTIES } from './episodes.js';
import { BASE_NODE_LABEL, MEMORY_LABEL } from './labels.js';
import { SUMMARIZED_BY_TYPE } from './narrative-queries.js';
import { readModeFragment, withCurrency } from './read-modes.js';
import { fromGraphVector, toGraphVector, type Row } from './values.js';
import type {
  ComputedContextVector,
  NeighborContentVector,
} from '../../reflection/domain/context-vector.js';

/**
 * Reflection's last stage recomputes `context_vec` for every `:Memory` node this run's
 * enrichment touched. This module owns the two batched reads that find that set and its
 * neighborhood, and the batched write that stores the result; `reflection/domain/context-vector.ts`
 * owns the weighted-mean itself.
 */

/** The cognitive types have no shared writer-side constant for the edge back to their episode (`cognitive-queries.ts` inlines it); this module needs the literal too. */
const EXTRACTED_FROM_TYPE = 'EXTRACTED_FROM';

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
    branch(`MATCH (n)-[:${EXTRACTED_FROM_TYPE}]->(:Episode { id: $episodeId })`),
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
 * One row per (affected node, edge to a vectored neighbor): neighbors outside the affected
 * set included, since a node's context is its whole graph neighborhood, not just what this
 * episode touched. Undirected (`-[r]-`) because a neighborhood is not a direction; direction
 * is the relationship's own semantics, the same reasoning `adjacency.ts` documents for
 * spreading activation. A neighbor with no `content_vec` (a pending-vector marker, a
 * structural backbone node) contributes nothing and is filtered out here, before the vector
 * ever reaches the domain math.
 */
function neighborContentVectorsStatement(
  nodeIds: readonly string[],
  reference?: Date,
): GraphStatement {
  const fragment = readModeFragment(withCurrency(reference), 'm', 'nb');
  const cypher = [
    'UNWIND $nodeIds AS nodeId',
    `MATCH (n:${BASE_NODE_LABEL} { id: nodeId })-[r]-(m:${BASE_NODE_LABEL})`,
    `WHERE m.id <> nodeId AND m.${MEMORY_PROPERTIES.contentVector} IS NOT NULL AND ${fragment.where}`,
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
 * The id seek goes through `AionNode` rather than `Memory`: migration 001 gives every node
 * the `aion_node_id_unique` constraint, but declares no id constraint on `Memory` itself
 * (only its vector and range indexes), so matching on `Memory { id: … }` would plan as a
 * label scan. Every id this stage writes already carries both labels.
 */
const WRITE_CONTEXT_VECTORS = [
  'UNWIND $entries AS entry',
  `MATCH (n:${BASE_NODE_LABEL}:${MEMORY_LABEL} { id: entry.id })`,
  `SET n.${CONTEXT_VECTOR_PROPERTY} = entry.vector`,
  'RETURN n.id AS id',
].join('\n');

/** The ids actually written, fewer than the batch when an affected node was forgotten between the two reads. */
export async function writeContextVectors(
  driver: Driver,
  entries: readonly ComputedContextVector[],
): Promise<string[]> {
  if (entries.length === 0) {
    return [];
  }
  return runWrite(
    driver,
    WRITE_CONTEXT_VECTORS,
    { entries: entries.map((entry) => ({ id: entry.id, vector: toGraphVector(entry.vector) })) },
    (row) => row.id as string,
  );
}
