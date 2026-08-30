import type { Driver } from 'neo4j-driver';

import { BITEMPORAL_PROPERTIES, currentOnly } from './bitemporal.js';
import { runRead } from './connection.js';
import { FACT_NODE_LABELS } from './supersession-queries.js';
import { toGraphInteger } from './values.js';

/**
 * The candidate window for the retro supersession sweep: episodes carrying a current
 * fact-bearing node, oldest occurrence first. Whether any one of them has already faced the
 * supersession stage lives in the ops ledger, not the graph, so this read hands back a window
 * of candidates for the caller to filter against `reflection:stage:supersession:{episodeId}`
 * rather than trying to join the two stores in one query.
 */

const FIND_FACT_BEARING_EPISODES = [
  'MATCH (n)-[:EXTRACTED_FROM]->(e:Episode)',
  'WHERE any(label IN labels(n) WHERE label IN $labels)',
  `  AND ${currentOnly('n')}`,
  `  AND ${currentOnly('e')}`,
  'WITH DISTINCT e',
  'RETURN e.id AS id',
  `ORDER BY e.${BITEMPORAL_PROPERTIES.occurredAt}, e.id`,
  'LIMIT $limit',
].join('\n');

/** Fact-bearing episode ids, oldest first, capped at `limit`. */
export async function findFactBearingEpisodesOldestFirst(
  driver: Driver,
  limit: number,
): Promise<string[]> {
  if (limit <= 0) {
    return [];
  }
  return runRead(
    driver,
    {
      cypher: FIND_FACT_BEARING_EPISODES,
      parameters: { labels: [...FACT_NODE_LABELS], limit: toGraphInteger(limit) },
    },
    (row) => row.id as string,
  );
}
