import type { Driver } from 'neo4j-driver';
import { BITEMPORAL_PROPERTIES } from '../bitemporal.js';
import { runRead } from '../connection.js';
import { CONTAINMENT_TYPE, MEMORY_PROPERTIES } from '../episodes.js';
import { BASE_NODE_LABEL } from '../labels.js';
import { NARRATIVE_PROPERTIES } from '../narrative-queries.js';
import type { Row } from '../values.js';

/**
 * Assertion reads for the maintenance operations, kept beside the other graph test-support
 * queries so every Cypher statement that runs lives under `infrastructure/graph/`. Separate
 * from `graph-queries.fixture.ts` only because the two together pass the line cap.
 */

async function readFirst<T>(
  driver: Driver,
  cypher: string,
  parameters: Record<string, unknown>,
  map: (row: Row) => T,
): Promise<T | undefined> {
  return (await runRead(driver, cypher, parameters, map))[0];
}

/** The sessions one episode reaches through the containment edge: what a backbone repair restores. */
export async function sessionIdsOfEpisode(driver: Driver, episodeId: string): Promise<string[]> {
  return runRead(
    driver,
    `MATCH (e:Episode { id: $id })-[:${CONTAINMENT_TYPE}]->(s:Session) RETURN s.id AS id`,
    { id: episodeId },
    (row) => row.id as string,
  );
}

/** The signals on those edges, so a repaired link is separable from the one intake wrote. */
export async function sessionLinkSignals(driver: Driver, episodeId: string): Promise<string[]> {
  const rows = await runRead(
    driver,
    `MATCH (e:Episode { id: $id })-[r:${CONTAINMENT_TYPE}]->(:Session) RETURN r.signals AS signals`,
    { id: episodeId },
    (row) => (row.signals as string[] | null) ?? [],
  );
  return rows.flat();
}

/** The grounding revision one narrative was written under; absent when it carries none. */
export async function narrativeGrounding(
  driver: Driver,
  id: string,
): Promise<string | undefined> {
  const value = await readFirst(
    driver,
    `MATCH (n:Narrative { id: $id }) RETURN n.${NARRATIVE_PROPERTIES.grounding} AS grounding`,
    { id },
    (row) => row.grounding,
  );
  return typeof value === 'string' ? value : undefined;
}

/** Standing bridges, newest first, with the sentence each one carries. */
export async function standingBridges(
  driver: Driver,
): Promise<{ id: string; text: string }[]> {
  return runRead(
    driver,
    [
      'MATCH (b:Bridge)',
      `WHERE b.${BITEMPORAL_PROPERTIES.forgottenAt} IS NULL`,
      `RETURN b.id AS id, coalesce(b.${MEMORY_PROPERTIES.text}, '') AS text`,
      `ORDER BY b.${BITEMPORAL_PROPERTIES.txFrom} DESC, b.id`,
    ].join('\n'),
    {},
    (row) => ({ id: row.id as string, text: row.text as string }),
  );
}

/** What a standing bridge is attached to, and the reason each attachment gives for existing. */
export async function bridgeEndpoints(
  driver: Driver,
): Promise<{ id: string; provenance: string[]; rationale: string }[]> {
  return runRead(
    driver,
    [
      'MATCH (b:Bridge)-[r:RELATED_TO]-(n:AionNode)',
      `WHERE b.${BITEMPORAL_PROPERTIES.forgottenAt} IS NULL`,
      'RETURN n.id AS id, coalesce(r.provenance, []) AS provenance,',
      "       coalesce(r.rationale, '') AS rationale",
    ].join('\n'),
    {},
    (row) => ({
      id: row.id as string,
      provenance: (row.provenance as string[] | null) ?? [],
      rationale: row.rationale as string,
    }),
  );
}

/** Every relationship type on any edge between two nodes, undirected: what orphan relink leaves behind. */
export async function relationshipTypesBetween(
  driver: Driver,
  left: string,
  right: string,
): Promise<string[]> {
  return runRead(
    driver,
    `MATCH (a:${BASE_NODE_LABEL} { id: $left })-[r]-(b:${BASE_NODE_LABEL} { id: $right }) RETURN type(r) AS type`,
    { left, right },
    (row) => row.type as string,
  );
}

/** Current episode ids, oldest first, for a test that has to clear the field before it seeds. */
export async function currentEpisodeIds(driver: Driver): Promise<string[]> {
  return runRead(
    driver,
    [
      'MATCH (e:Episode)',
      `WHERE e.${BITEMPORAL_PROPERTIES.forgottenAt} IS NULL`,
      `RETURN e.id AS id ORDER BY e.${BITEMPORAL_PROPERTIES.txFrom}, e.id`,
    ].join('\n'),
    {},
    (row) => row.id as string,
  );
}
