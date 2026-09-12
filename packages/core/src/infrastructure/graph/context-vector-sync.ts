import type { Driver } from 'neo4j-driver';

import { BITEMPORAL_PROPERTIES } from './bitemporal.js';
import { runRead, runWrite, type GraphStatement, type GraphTransaction } from './connection.js';
import { CONTEXT_VECTOR_PROPERTY } from './context-vector-queries.js';
import { DECAYED_AT_PROPERTY } from './edge-weights.js';
import { MEMORY_PROPERTIES } from './episodes.js';
import { BASE_NODE_LABEL, MEMORY_LABEL } from './labels.js';
import { readModeFragment, withCurrency } from './read-modes.js';
import {
  fromGraphVector,
  toGraphDateTime,
  toGraphInteger,
  toGraphVector,
  type Row,
} from './values.js';
import type { ComputedContextVector } from '../../reflection/domain/context-vector.js';

/**
 * Every statement that moves `context_vec`, and the reads one guarded recomputation needs.
 *
 * `context_vec` is a served property: recall reads it. Nothing re-triggers a recomputation when
 * a neighborhood changes after the fact — reinforcement moves an edge's `updated_at`, the decay
 * sweep moves `decayed_at` and `strength`, and the prune close moves `valid_until`, each on its
 * own schedule — so three different passes have reason to write it, and they used to write it
 * three different ways. The stamp is what tells a later tick "already looked at" from "never
 * looked at", and one of the three wrote the vector without it.
 *
 * Now all three publish `context_vector_sync` and land here. The transaction-scoped statements
 * below are the ones that operation uses; the driver-scoped ones above them serve the run-start
 * binding, which is taken before any guard is held. `context-vector-queries.ts` keeps the
 * unguarded READS the reflection stage nominates its population from.
 */

export const CONTEXT_VECTOR_SYNCED_AT_PROPERTY = 'context_vec_synced_at';

/**
 * A `:Memory` node counts as stale when it has never been synced by this path, or when a
 * neighbor edge has moved since the last sync. Movement is the newest of the three stamps a
 * weight change writes, because each writer moves a different one: reinforcement `updated_at`,
 * decay `decayed_at`, the prune close `valid_until`. A closed edge stays in this scan for that
 * last reason, and drops out of the neighborhood the recompute reads.
 *
 * Oldest-synced-first, so a backlog drains in the order it fell behind rather than thrashing on
 * whichever node changed most recently.
 */
const EDGE_MOVEMENT_STAMPS = [
  'r.updated_at',
  `r.${DECAYED_AT_PROPERTY}`,
  `r.${BITEMPORAL_PROPERTIES.validUntil}`,
].join(', ');

const FIND_STALE_CONTEXT_VECTOR_NODES = [
  `MATCH (n:${MEMORY_LABEL})`,
  `WHERE n.${MEMORY_PROPERTIES.contentVector} IS NOT NULL`,
  `  AND n.${BITEMPORAL_PROPERTIES.forgottenAt} IS NULL`,
  `MATCH (n)-[r]-(m:${BASE_NODE_LABEL})`,
  `WHERE m.id <> n.id AND m.${MEMORY_PROPERTIES.contentVector} IS NOT NULL`,
  `  AND m.${BITEMPORAL_PROPERTIES.forgottenAt} IS NULL`,
  `WITH n, reduce(newest = null, stamp IN [${EDGE_MOVEMENT_STAMPS}] |`,
  '       CASE WHEN stamp IS NOT NULL AND (newest IS NULL OR stamp > newest)',
  '            THEN stamp ELSE newest END) AS edgeMoved',
  'WITH n, max(edgeMoved) AS newestNeighborUpdate',
  `WHERE n.${CONTEXT_VECTOR_SYNCED_AT_PROPERTY} IS NULL`,
  `   OR newestNeighborUpdate > n.${CONTEXT_VECTOR_SYNCED_AT_PROPERTY}`,
  `RETURN n.id AS id`,
  `ORDER BY coalesce(n.${CONTEXT_VECTOR_SYNCED_AT_PROPERTY}, n.${BITEMPORAL_PROPERTIES.txFrom}), n.id`,
  'LIMIT $limit',
].join('\n');

export async function findStaleContextVectorNodes(
  driver: Driver,
  limit: number,
): Promise<string[]> {
  if (limit <= 0) {
    return [];
  }
  return runRead(
    driver,
    FIND_STALE_CONTEXT_VECTOR_NODES,
    { limit: toGraphInteger(limit) },
    (row) => row.id as string,
  );
}

const WRITE_CONTEXT_VECTOR_SYNC = [
  'UNWIND $entries AS entry',
  `MATCH (n:${BASE_NODE_LABEL}:${MEMORY_LABEL} { id: entry.id })`,
  `SET n.${CONTEXT_VECTOR_PROPERTY} = entry.vector, n.${CONTEXT_VECTOR_SYNCED_AT_PROPERTY} = $now`,
  'RETURN n.id AS id',
].join('\n');

/** The ids actually written, fewer than the batch when a stale node was forgotten between the two reads. */
export async function writeContextVectorSync(
  driver: Driver,
  entries: readonly ComputedContextVector[],
  now: Date,
): Promise<string[]> {
  if (entries.length === 0) {
    return [];
  }
  return runWrite(
    driver,
    WRITE_CONTEXT_VECTOR_SYNC,
    {
      entries: entries.map((entry) => ({ id: entry.id, vector: toGraphVector(entry.vector) })),
      now: toGraphDateTime(now),
    },
    (row: Row) => row.id as string,
  );
}

const CLEAR_CONTEXT_VECTOR = [
  'UNWIND $ids AS nodeId',
  `MATCH (n:${BASE_NODE_LABEL}:${MEMORY_LABEL} { id: nodeId })`,
  `SET n.${CONTEXT_VECTOR_PROPERTY} = null, n.${CONTEXT_VECTOR_SYNCED_AT_PROPERTY} = $now`,
  'RETURN n.id AS id',
].join('\n');

/**
 * Removes a retained node's context vector and stamps the sync that removed it.
 *
 * The one caller is the deletion repair: a node whose last vectored neighbor was removed has a
 * stored context computed from a neighborhood that no longer exists, and the timestamp scan above
 * structurally cannot see that — it looks for an edge that moved, and the edge is gone. Only a
 * CERTIFIED COMPLETE reading of the current neighborhood may call this. `content_vec` is never
 * touched: what the node itself says is unchanged by what stopped standing next to it.
 */
export async function clearContextVectorSync(
  driver: Driver,
  ids: readonly string[],
  now: Date,
): Promise<string[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) {
    return [];
  }
  return runWrite(
    driver,
    CLEAR_CONTEXT_VECTOR,
    { ids: unique, now: toGraphDateTime(now) },
    (row: Row) => row.id as string,
  );
}

const MARK_CONTEXT_VECTOR_SYNCED = [
  'UNWIND $ids AS nodeId',
  `MATCH (n:${BASE_NODE_LABEL}:${MEMORY_LABEL} { id: nodeId })`,
  `SET n.${CONTEXT_VECTOR_SYNCED_AT_PROPERTY} = $now`,
  'RETURN n.id AS id',
].join('\n');

/**
 * The stamp without the vector, for a stale node the pass looked at and computed nothing for:
 * a neighborhood whose every edge sits at zero strength, or whose stored vectors will not
 * coerce. The scan is ordered by this stamp, so a node left unstamped comes back at the head of
 * every later tick and the backlog behind it never drains.
 */
export async function markContextVectorSynced(
  driver: Driver,
  ids: readonly string[],
  now: Date,
): Promise<string[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) {
    return [];
  }
  return runWrite(
    driver,
    MARK_CONTEXT_VECTOR_SYNCED,
    { ids: unique, now: toGraphDateTime(now) },
    (row: Row) => row.id as string,
  );
}

/**
 * The same three writes inside a caller's transaction, for the guarded operation.
 *
 * Each returns the ids the statement matched. Under the guard that set is not a count to
 * compare loosely: the operation matched the same predicate a moment earlier in the same
 * transaction, so a smaller answer here is an invariant failure rather than a node that
 * slipped away, and the operation raises on it.
 */
export async function writeContextVectorsInTransaction(
  tx: GraphTransaction,
  entries: readonly ComputedContextVector[],
  now: Date,
): Promise<string[]> {
  if (entries.length === 0) {
    return [];
  }
  return tx.run(
    WRITE_CONTEXT_VECTOR_SYNC,
    {
      entries: entries.map((entry) => ({ id: entry.id, vector: toGraphVector(entry.vector) })),
      now: toGraphDateTime(now),
    },
    (row: Row) => row.id as string,
  );
}

export async function clearContextVectorsInTransaction(
  tx: GraphTransaction,
  ids: readonly string[],
  now: Date,
): Promise<string[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) {
    return [];
  }
  return tx.run(
    CLEAR_CONTEXT_VECTOR,
    { ids: unique, now: toGraphDateTime(now) },
    (row: Row) => row.id as string,
  );
}

export async function stampContextVectorsInTransaction(
  tx: GraphTransaction,
  ids: readonly string[],
  now: Date,
): Promise<string[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) {
    return [];
  }
  return tx.run(
    MARK_CONTEXT_VECTOR_SYNCED,
    { ids: unique, now: toGraphDateTime(now) },
    (row: Row) => row.id as string,
  );
}

/**
 * Exactly the predicate the three writes above match on, asked as a question.
 *
 * A bound id can be present in the graph and still be unwritable here: every context-vector
 * statement requires `:Memory`, and a retained neighbour outside that label has no context
 * vector to recompute, clear or stamp. Asking first is what lets the operation name that node
 * instead of discovering it as a write that matched nothing.
 */
const READ_CONTEXT_VECTOR_SUBJECTS = [
  'UNWIND $ids AS wanted',
  `MATCH (n:${BASE_NODE_LABEL}:${MEMORY_LABEL} { id: wanted })`,
  'RETURN n.id AS id',
].join('\n');

export async function readContextVectorSubjects(
  tx: GraphTransaction,
  ids: readonly string[],
): Promise<ReadonlySet<string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) {
    return new Set();
  }
  const rows = await tx.run(
    READ_CONTEXT_VECTOR_SUBJECTS,
    { ids: unique },
    (row: Row) => row.id as string,
  );
  return new Set(rows);
}

/** One current neighbour edge, before any judgment about whether it contributes. */
export type NeighborhoodRow = {
  readonly nodeId: string;
  readonly neighborId: string;
  readonly strength: number;
  /** Whether the neighbour holds a stored content vector at all, coercible or not. */
  readonly stored: boolean;
  /** Absent when nothing is stored, or when what is stored will not coerce to numbers. */
  readonly vector: readonly number[] | undefined;
};

/**
 * The neighbourhood as the guard sees it, with the rows a recomputation cannot use left IN.
 *
 * `findNeighborContentVectors` filters `content_vec IS NOT NULL` in Cypher and drops an
 * uncoercible vector in TypeScript, so a node with no neighbours, a node whose neighbours are
 * still waiting for their embeddings, and a node whose neighbours hold unreadable vectors all
 * arrive at the caller as the same empty answer. That is tolerable for a pass that only skips
 * and stamps. It is not tolerable for one that CLEARS a served property on the strength of that
 * answer, so this read keeps the distinction and the operation decides on it.
 *
 * Otherwise identical to the unguarded read: undirected, `valid_until IS NULL` so a pruned edge
 * does not weight the context it was closed to retire, and the same read-mode fragment.
 */
function neighborhoodStatement(nodeIds: readonly string[], reference: Date): GraphStatement {
  const fragment = readModeFragment(withCurrency(reference), 'm', 'nb');
  const cypher = [
    'UNWIND $nodeIds AS nodeId',
    `MATCH (n:${BASE_NODE_LABEL} { id: nodeId })-[r]-(m:${BASE_NODE_LABEL})`,
    'WHERE m.id <> nodeId',
    `  AND r.${BITEMPORAL_PROPERTIES.validUntil} IS NULL AND ${fragment.where}`,
    'RETURN nodeId, m.id AS neighborId,',
    '       coalesce(r.strength, 1.0) AS strength,',
    `       m.${MEMORY_PROPERTIES.contentVector} AS vector`,
  ].join('\n');

  return { cypher, parameters: { nodeIds, ...fragment.parameters } };
}

export async function readNeighborhood(
  tx: GraphTransaction,
  nodeIds: readonly string[],
  reference: Date,
): Promise<readonly NeighborhoodRow[]> {
  const unique = [...new Set(nodeIds)];
  if (unique.length === 0) {
    return [];
  }
  const statement = neighborhoodStatement(unique, reference);
  return tx.run(statement.cypher, statement.parameters, (row: Row) => ({
    nodeId: row.nodeId as string,
    neighborId: row.neighborId as string,
    strength: row.strength as number,
    stored: row.vector !== null && row.vector !== undefined,
    vector: fromGraphVector(row.vector),
  }));
}
