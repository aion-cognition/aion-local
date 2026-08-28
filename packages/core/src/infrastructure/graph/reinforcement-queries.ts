import type { Driver } from 'neo4j-driver';
import { runRead, type GraphStatement } from './connection.js';
import { readModeFragment, withCurrency } from './read-modes.js';

/**
 * Finds all entity and cognitive node IDs extracted from an episode, used to enqueue
 * Hebbian reinforcement signals for co-extracted pairs (whitepaper §7.1, P3-13).
 */

function coExtractedNodesStatement(episodeId: string): GraphStatement {
  const fragment = readModeFragment(withCurrency(), 'n');
  return {
    cypher: [
      'MATCH (e:Episode { id: $episodeId })',
      'MATCH (n:AionNode)',
      `WHERE ${fragment.where}`,
      '  AND (',
      '    (e)-[:MENTIONS]->(n)',
      '    OR (n)-[:PARTICIPATES_IN]->(e)',
      '    OR (n)-[:EXTRACTED_FROM]->(e)',
      '  )',
      'RETURN DISTINCT n.id AS id',
    ].join('\n'),
    parameters: { episodeId, ...fragment.parameters },
  };
}

/**
 * Loads all node IDs that were extracted from or mentioned in an episode.
 * These include entities (via MENTIONS or PARTICIPATES_IN) and cognitive nodes (via EXTRACTED_FROM).
 */
export async function findCoExtractedNodeIds(
  driver: Driver,
  episodeId: string,
): Promise<readonly string[]> {
  const statement = coExtractedNodesStatement(episodeId);
  const rows = await runRead(
    driver,
    statement.cypher,
    statement.parameters,
    (row) => row.id as string,
  );
  return rows;
}
