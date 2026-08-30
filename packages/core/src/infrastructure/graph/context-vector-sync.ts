import neo4j, { type Driver } from 'neo4j-driver';

import { runRead, runWrite } from './connection.js';
import { BASE_NODE_LABEL } from './labels.js';
import { toGraphDateTime, toGraphVector, type Row } from './values.js';
import type { ComputedContextVector } from '../../reflection/domain/context-vector.js';

/**
 * `context_vec` is written once by the reflection pipeline's last stage, from the
 * neighborhood a node had at enrichment time (`context-vector-queries.ts`). Nothing
 * re-triggers that write when the neighborhood changes later: Hebbian reinforcement and
 * decay move edge `updated_at` and `strength` on their own schedule, so a node's stored
 * context can drift from its current neighbors without any reflection run to catch it.
 *
 * This module is the introspector's own write path for that drift, kept apart from the
 * reflection stage's: it stamps `context_vec_synced_at` so a later tick can tell "already
 * current" from "never looked at", which the reflection stage's write has no need to do.
 */

const MEMORY_LABEL = 'Memory';
export const CONTEXT_VECTOR_SYNCED_AT_PROPERTY = 'context_vec_synced_at';

function toGraphInteger(value: number): unknown {
  return neo4j.int(Math.trunc(value));
}

/**
 * A `:Memory` node counts as stale when it has never been synced by this path, or when a
 * neighbor edge has moved since the last sync. Oldest-synced-first, so a backlog drains in
 * the order it fell behind rather than thrashing on whichever node changed most recently.
 */
const FIND_STALE_CONTEXT_VECTOR_NODES = [
  `MATCH (n:${MEMORY_LABEL})`,
  'WHERE n.content_vec IS NOT NULL AND n.forgotten_at IS NULL',
  `MATCH (n)-[r]-(m:${BASE_NODE_LABEL})`,
  'WHERE m.id <> n.id AND m.content_vec IS NOT NULL AND m.forgotten_at IS NULL',
  'WITH n, max(r.updated_at) AS newestNeighborUpdate',
  `WHERE n.${CONTEXT_VECTOR_SYNCED_AT_PROPERTY} IS NULL`,
  `   OR newestNeighborUpdate > n.${CONTEXT_VECTOR_SYNCED_AT_PROPERTY}`,
  `RETURN n.id AS id`,
  `ORDER BY coalesce(n.${CONTEXT_VECTOR_SYNCED_AT_PROPERTY}, n.tx_from), n.id`,
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
  `SET n.context_vec = entry.vector, n.${CONTEXT_VECTOR_SYNCED_AT_PROPERTY} = $now`,
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
