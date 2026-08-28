import neo4j, { type Driver } from 'neo4j-driver';
import { BITEMPORAL_PROPERTIES } from './bitemporal.js';
import { runRead, runWrite } from './connection.js';
import { MEMORY_PROPERTIES } from './episodes.js';
import type { Vector } from '../providers/types.js';
import { toGraphVector } from './values.js';

/**
 * A `:Memory` node whose `content_vec` is absent is the pending-vector marker: intake
 * commits the episode before it embeds, so between the commit and the follow-up write the
 * node is durable and unvectorized. There is no flag property to keep in sync with it —
 * the missing vector is the state, and writing the vector clears it.
 *
 * `:Memory` is the label migration 001 declares `content_vec_idx` on, so it is also the
 * exact set of nodes a missing vector makes invisible to vector search.
 */
const MEMORY_LABEL = 'Memory';

export type PendingVectorNode = {
  readonly id: string;
  readonly text: string;
};

export type ContentVectorEntry = {
  readonly id: string;
  readonly vector: Vector;
};

/** Procedure arguments and `LIMIT` are Cypher INTEGER; a plain JS number arrives as FLOAT and is rejected. */
function toGraphInteger(value: number): unknown {
  return neo4j.int(Math.trunc(value));
}

/**
 * Oldest first, so a backlog drains in the order it accumulated and a long outage does not
 * leave the first experience of the window waiting behind the last. `text` is what gets
 * embedded, so a node without one is not pending — it is a memory type that carries no
 * body, and no later call can give it a vector.
 */
const FIND_PENDING_VECTOR_NODES = [
  `MATCH (n:${MEMORY_LABEL})`,
  `WHERE n.${MEMORY_PROPERTIES.contentVector} IS NULL AND n.${MEMORY_PROPERTIES.text} IS NOT NULL`,
  `RETURN n.id AS id, n.${MEMORY_PROPERTIES.text} AS text`,
  `ORDER BY n.${BITEMPORAL_PROPERTIES.txFrom}, n.id`,
  'LIMIT $limit',
].join('\n');

export async function findPendingVectorNodes(
  driver: Driver,
  limit: number,
): Promise<PendingVectorNode[]> {
  if (limit <= 0) {
    return [];
  }
  return runRead(driver, FIND_PENDING_VECTOR_NODES, { limit: toGraphInteger(limit) }, (row) => ({
    id: row.id as string,
    text: row.text as string,
  }));
}

/**
 * One round trip for the whole batch. The write is a plain `SET` rather than a
 * write-if-absent: the vector is a deterministic function of the node's own text and the
 * embed model, so a second pass over the same node writes the same floats, and two workers
 * racing the same backlog converge instead of conflicting.
 */
const WRITE_CONTENT_VECTORS = [
  'UNWIND $entries AS entry',
  `MATCH (n:${MEMORY_LABEL} { id: entry.id })`,
  `SET n.${MEMORY_PROPERTIES.contentVector} = entry.vector`,
  'RETURN n.id AS id',
].join('\n');

/** The ids actually written, which is fewer than the batch when a node was superseded away mid-drain. */
export async function writeContentVectors(
  driver: Driver,
  entries: readonly ContentVectorEntry[],
): Promise<string[]> {
  if (entries.length === 0) {
    return [];
  }
  return runWrite(
    driver,
    WRITE_CONTENT_VECTORS,
    { entries: entries.map((entry) => ({ id: entry.id, vector: toGraphVector(entry.vector) })) },
    (row) => row.id as string,
  );
}
