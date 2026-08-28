import type { Driver } from 'neo4j-driver';
import { runRead } from '../connection.js';
import { BASE_NODE_LABEL } from '../labels.js';
import type { Row } from '../values.js';

/**
 * Read-only assertions for integration tests that live outside this directory. Cypher lives
 * in `graph/` without exception, tests included: a query written next to the code it checks
 * is a query that can quietly encode a filter the adapter does not actually apply, and the
 * whole point of the rule is that there is one place to read for what the substrate does.
 */
async function readFirst<T>(
  driver: Driver,
  cypher: string,
  parameters: Record<string, unknown>,
  map: (row: Row) => T,
): Promise<T | undefined> {
  const rows = await runRead(driver, cypher, parameters, map);
  return rows[0];
}

async function count(
  driver: Driver,
  cypher: string,
  parameters: Record<string, unknown> = {},
): Promise<number> {
  return (await readFirst(driver, cypher, parameters, (row) => row.c as number)) ?? 0;
}

export async function nodeProperties(driver: Driver, id: string): Promise<Record<string, unknown>> {
  const props = await readFirst(
    driver,
    `MATCH (n:${BASE_NODE_LABEL} { id: $id }) RETURN properties(n) AS props`,
    { id },
    (row) => row.props as Record<string, unknown>,
  );
  return props ?? {};
}

export async function nodeLabels(driver: Driver, id: string): Promise<string[]> {
  const labels = await readFirst(
    driver,
    `MATCH (n:${BASE_NODE_LABEL} { id: $id }) RETURN labels(n) AS labels`,
    { id },
    (row) => row.labels as string[],
  );
  return [...(labels ?? [])].sort();
}

/** Every property of every node, serialized — what a "the raw secret is nowhere" assertion scans. */
export async function everyStoredProperty(driver: Driver): Promise<string> {
  const rows = await runRead(driver, 'MATCH (n) RETURN properties(n) AS props', {}, (row) => row.props);
  return JSON.stringify(rows);
}

export async function countNodes(driver: Driver): Promise<number> {
  return count(driver, 'MATCH (n) RETURN count(n) AS c');
}

export async function countRelationships(driver: Driver): Promise<number> {
  return count(driver, 'MATCH ()-[r]->() RETURN count(r) AS c');
}

export async function countNodesWithId(driver: Driver, label: string, id: string): Promise<number> {
  return count(driver, `MATCH (n:${label} { id: $id }) RETURN count(n) AS c`, { id });
}

export async function countEdges(
  driver: Driver,
  type: string,
  sourceId: string,
  targetId: string,
): Promise<number> {
  return count(
    driver,
    `MATCH ({ id: $sourceId })-[r:${type}]->({ id: $targetId }) RETURN count(r) AS c`,
    { sourceId, targetId },
  );
}

export async function countOutgoingEdges(
  driver: Driver,
  type: string,
  sourceId: string,
): Promise<number> {
  return count(driver, `MATCH ({ id: $sourceId })-[r:${type}]->() RETURN count(r) AS c`, {
    sourceId,
  });
}

/** The id on the far end of one outgoing edge, for the backbone links a session writes once. */
export async function edgeTargetId(
  driver: Driver,
  type: string,
  sourceId: string,
): Promise<string | undefined> {
  return readFirst(
    driver,
    `MATCH ({ id: $sourceId })-[:${type}]->(target) RETURN target.id AS id`,
    { sourceId },
    (row) => row.id as string,
  );
}

export async function countNodesInSession(
  driver: Driver,
  label: 'Episode' | 'Turn',
  sessionId: string,
): Promise<number> {
  return count(driver, `MATCH (n:${label} { session_id: $sessionId }) RETURN count(n) AS c`, {
    sessionId,
  });
}

export async function episodeIdsInSession(driver: Driver, sessionId: string): Promise<string[]> {
  return runRead(
    driver,
    'MATCH (e:Episode { session_id: $sessionId }) RETURN e.id AS id',
    { sessionId },
    (row) => row.id as string,
  );
}

/** An episode's turns in sequence order, whole, so a test asserts over stored shape rather than a projection. */
export async function turnsOfEpisode(
  driver: Driver,
  episodeId: string,
): Promise<Array<Record<string, unknown>>> {
  return runRead(
    driver,
    [
      'MATCH (t:Turn)-[:PARTICIPATES_IN]->(:Episode { id: $episodeId })',
      'RETURN properties(t) AS props ORDER BY t.sequence',
    ].join('\n'),
    { episodeId },
    (row) => row.props as Record<string, unknown>,
  );
}

export async function countChainedTurns(driver: Driver, episodeId: string): Promise<number> {
  return count(
    driver,
    [
      'MATCH (later:Turn)-[r:FOLLOWS]->(earlier:Turn)',
      'WHERE later.source_episode_id = $episodeId AND earlier.source_episode_id = $episodeId',
      'RETURN count(r) AS c',
    ].join('\n'),
    { episodeId },
  );
}
