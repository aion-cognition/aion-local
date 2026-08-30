import type { Driver } from 'neo4j-driver';

import { currentOnly } from './bitemporal.js';
import { readFirst } from './connection.js';
import { CONTAINMENT_TYPE, MEMORY_PROPERTIES } from './episodes.js';
import { BACKBONE_TYPES, EXTRACTION_TYPE } from './labels.js';
import { toGraphInteger } from './values.js';

/**
 * The graph half of the introspector's health snapshot. Everything here is a count, runs on
 * the maintenance tick rather than on a request, and reads current nodes only: a forgotten or
 * superseded node is history, and history cannot be repaired.
 *
 * The protected set doubles as the backbone set. Those types are the graph's own wiring plus
 * its provenance trail, so a node whose every edge is one of them is attached to the structure
 * and to nothing it was ever associated with. That is the fragmentation spreading activation
 * cannot cross, which is what makes it the orphan measure rather than "no edges at all".
 */

/** Ceiling on the scans below, so one pathological substrate cannot turn a tick into an unbounded scan. */
export const DEFAULT_HEALTH_SCAN_LIMIT = 50_000;

export type VectorParityCounts = {
  /** Current `:Memory` nodes carrying text, which is the set that should hold a content vector. */
  readonly expected: number;
  /** Of those, the ones that actually have one. */
  readonly vectored: number;
};

/**
 * The same population `findPendingVectorNodes` drains, counted rather than listed. A node with
 * no text is excluded from both halves: nothing can embed it, so counting it as a gap would
 * report a parity no backfill could ever close.
 */
const COUNT_VECTOR_PARITY = [
  'MATCH (n:Memory)',
  `WHERE ${currentOnly('n')} AND n.${MEMORY_PROPERTIES.text} IS NOT NULL`,
  'WITH n LIMIT $limit',
  'RETURN count(n) AS expected,',
  `  count(n.${MEMORY_PROPERTIES.contentVector}) AS vectored`,
].join('\n');

export async function countVectorParity(
  driver: Driver,
  limit: number = DEFAULT_HEALTH_SCAN_LIMIT,
): Promise<VectorParityCounts> {
  const counts = await readFirst(
    driver,
    COUNT_VECTOR_PARITY,
    { limit: toGraphInteger(limit) },
    (row) => ({
      expected: row.expected as number,
      vectored: row.vectored as number,
    }),
  );
  return counts ?? { expected: 0, vectored: 0 };
}

export type OrphanCounts = {
  readonly nodes: number;
  /** Current `:Memory` nodes whose every edge is a backbone or provenance type. */
  readonly orphans: number;
};

/**
 * An episode nothing has been extracted from is waiting on reflection, not fragmented. It has
 * only its backbone edges because the stage that gives it associations has not run yet, and
 * counting it here made a growing enrichment backlog read as a structural emergency: the
 * repair would then write a heuristic edge onto it, drop it out of the count, and leave it
 * exactly as unenriched as before. The backlog has its own metric, and its own operation.
 */
const AWAITING_ENRICHMENT = `n:Episode AND NOT EXISTS { MATCH ()-[:${EXTRACTION_TYPE}]->(n) }`;

const COUNT_ORPHANS = [
  'MATCH (n:Memory)',
  `WHERE ${currentOnly('n')}`,
  `  AND NOT (${AWAITING_ENRICHMENT})`,
  'WITH n LIMIT $limit',
  'OPTIONAL MATCH (n)-[r]-()',
  `  WHERE NOT type(r) IN [${BACKBONE_TYPES}]`,
  'WITH n, count(r) AS associations',
  'RETURN count(n) AS nodes, sum(CASE WHEN associations = 0 THEN 1 ELSE 0 END) AS orphans',
].join('\n');

export async function countOrphanNodes(
  driver: Driver,
  limit: number = DEFAULT_HEALTH_SCAN_LIMIT,
): Promise<OrphanCounts> {
  const counts = await readFirst(
    driver,
    COUNT_ORPHANS,
    { limit: toGraphInteger(limit) },
    (row) => ({
      nodes: row.nodes as number,
      orphans: row.orphans as number,
    }),
  );
  return counts ?? { nodes: 0, orphans: 0 };
}

/**
 * The tier-1 backbone check: an episode reaches its session through `PARTICIPATES_IN`, and one
 * that does not is unreachable from the session narrative, from the context vectors, and from
 * every traversal that starts at a session. This is the "missing core relationships"
 * condition, counted rather than described.
 */
const COUNT_EPISODES_WITHOUT_SESSION = [
  'MATCH (n:Episode)',
  `WHERE ${currentOnly('n')}`,
  'WITH n LIMIT $limit',
  `WITH n WHERE NOT (n)-[:${CONTAINMENT_TYPE}]->(:Session)`,
  'RETURN count(n) AS missing',
].join('\n');

export async function countEpisodesWithoutSession(
  driver: Driver,
  limit: number = DEFAULT_HEALTH_SCAN_LIMIT,
): Promise<number> {
  const missing = await readFirst(
    driver,
    COUNT_EPISODES_WITHOUT_SESSION,
    { limit: toGraphInteger(limit) },
    (row) => row.missing as number,
  );
  return missing ?? 0;
}
