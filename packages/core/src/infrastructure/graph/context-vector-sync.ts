import type { Driver } from 'neo4j-driver';

import { BITEMPORAL_PROPERTIES } from './bitemporal.js';
import { runRead, runWrite } from './connection.js';
import { CONTEXT_VECTOR_PROPERTY } from './context-vector-queries.js';
import { DECAYED_AT_PROPERTY } from './edge-weights.js';
import { MEMORY_PROPERTIES } from './episodes.js';
import { BASE_NODE_LABEL, MEMORY_LABEL } from './labels.js';
import { toGraphDateTime, toGraphInteger, toGraphVector, type Row } from './values.js';
import type { ComputedContextVector } from '../../reflection/domain/context-vector.js';

/**
 * `context_vec` is written once by the reflection pipeline's last stage, from the
 * neighborhood a node had at enrichment time (`context-vector-queries.ts`). Nothing
 * re-triggers that write when the neighborhood changes later: reinforcement moves an edge's
 * `updated_at`, the decay sweep moves `decayed_at` and `strength`, and the prune close moves
 * `valid_until`, each on its own schedule, so a node's stored context can drift from its
 * current neighbors without any reflection run to catch it.
 *
 * This module is the introspector's own write path for that drift, kept apart from the
 * reflection stage's: it stamps `context_vec_synced_at` so a later tick can tell "already
 * current" from "never looked at", which the reflection stage's write has no need to do.
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
