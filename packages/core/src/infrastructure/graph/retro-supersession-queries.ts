import neo4j, { type Driver } from 'neo4j-driver';
import { BITEMPORAL_PROPERTIES } from './bitemporal.js';
import { runRead, type GraphStatement } from './connection.js';
import { FACT_NODE_LABELS } from './supersession-queries.js';
import type { Row } from './values.js';

/**
 * The candidate window for the retro supersession sweep: episodes carrying a current
 * fact-bearing node, oldest occurrence first. Whether any one of them has already faced the
 * supersession stage lives in the ops ledger, not the graph, so this read hands back a window
 * of candidates for the caller to filter against `reflection:stage:supersession:{episodeId}`
 * rather than trying to join the two stores in one query.
 */

function toGraphInteger(value: number): unknown {
  return neo4j.int(Math.trunc(value));
}

const FIND_FACT_BEARING_EPISODES = [
  'MATCH (n)-[:EXTRACTED_FROM]->(e:Episode)',
  'WHERE any(label IN labels(n) WHERE label IN $labels)',
  `  AND n.${BITEMPORAL_PROPERTIES.validUntil} IS NULL AND n.${BITEMPORAL_PROPERTIES.forgottenAt} IS NULL`,
  `  AND e.${BITEMPORAL_PROPERTIES.validUntil} IS NULL AND e.${BITEMPORAL_PROPERTIES.forgottenAt} IS NULL`,
  'WITH DISTINCT e',
  'RETURN e.id AS id',
  `ORDER BY e.${BITEMPORAL_PROPERTIES.occurredAt}, e.id`,
  'LIMIT $limit',
].join('\n');

function statement(limit: number): GraphStatement {
  return {
    cypher: FIND_FACT_BEARING_EPISODES,
    parameters: { labels: [...FACT_NODE_LABELS], limit: toGraphInteger(limit) },
  };
}

/** Fact-bearing episode ids, oldest first, capped at `limit`. */
export async function findFactBearingEpisodesOldestFirst(
  driver: Driver,
  limit: number,
): Promise<string[]> {
  if (limit <= 0) {
    return [];
  }
  const built = statement(limit);
  return runRead(driver, built.cypher, built.parameters, (row: Row) => row.id as string);
}
