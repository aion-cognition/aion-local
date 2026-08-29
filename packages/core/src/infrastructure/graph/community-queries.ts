import neo4j, { type Driver } from 'neo4j-driver';
import { BITEMPORAL_PROPERTIES } from './bitemporal.js';
import { runRead, runWrite } from './connection.js';
import { PROTECTED_RELATIONSHIP_TYPES } from './protected-relationships.js';
import { STRUCTURAL_PROPERTY } from './seed-queries.js';

/**
 * Community detection over the content graph, through the Graph Data Science plugin the
 * Neo4j image ships. Label propagation is the algorithm the design names: it needs no
 * parameter for the number of communities, it converges in a handful of iterations, and it
 * answers on a graph whose real structure is a few dense neighbourhoods with thin joins.
 *
 * The projection is in-memory and named, and it is dropped again whatever happens, so a run
 * that fails partway leaves the plugin's catalog as it found it. Backbone edges stay out of
 * it: they connect every node to the same session, member and workspace, and a projection
 * carrying them collapses the whole substrate into one community that says nothing.
 */

/** The property label propagation writes. A node with none has never been in a projection. */
export const COMMUNITY_PROPERTY = 'community_id';

/** One name, reused every run, so an abandoned projection is reclaimed rather than accumulated. */
export const CONTENT_PROJECTION_NAME = 'aion-content';

/** Label propagation converges in a few passes; the ceiling is a guard, not a target. */
export const COMMUNITY_MAX_ITERATIONS = 10;

const BACKBONE_TYPES = PROTECTED_RELATIONSHIP_TYPES.map((type) => `'${type}'`).join(', ');

const CURRENT = (variable: string): string =>
  [
    `${variable}.${BITEMPORAL_PROPERTIES.validUntil} IS NULL`,
    `${variable}.${BITEMPORAL_PROPERTIES.forgottenAt} IS NULL`,
  ].join(' AND ');

/** Procedure arguments are Cypher INTEGER; a plain JS number arrives as FLOAT and is rejected. */
function toGraphInteger(value: number): unknown {
  return neo4j.int(Math.trunc(value));
}

/**
 * Whether the plugin is loaded at all. The image ships it, but a server someone started by
 * hand may not, and an operation that cannot run has to say so rather than fail.
 */
export async function labelPropagationAvailable(driver: Driver): Promise<boolean> {
  const rows = await runRead(
    driver,
    "SHOW PROCEDURES YIELD name WHERE name = 'gds.labelPropagation.write' RETURN count(*) AS count",
    {},
    (row) => row['count'] as number,
  );
  return (rows[0] ?? 0) > 0;
}

const COUNT_PROJECTABLE_NODES = [
  'MATCH (n:Memory)',
  `WHERE ${CURRENT('n')} AND coalesce(n.${STRUCTURAL_PROPERTY}, false) = false`,
  'RETURN count(n) AS count',
].join('\n');

/**
 * The size of the projection before it is built. The projection is all-or-nothing: a node
 * limit would leave relationships pointing at nodes outside it, which the plugin rejects, and
 * dropping those relationships would answer with communities of a graph that does not exist.
 * So the bound is a refusal above the cap rather than a truncation.
 */
export async function countProjectableNodes(driver: Driver): Promise<number> {
  const rows = await runRead(driver, COUNT_PROJECTABLE_NODES, {}, (row) => row['count'] as number);
  return rows[0] ?? 0;
}

const PROJECT_NODES = [
  'MATCH (n:Memory)',
  `WHERE ${CURRENT('n')} AND coalesce(n.${STRUCTURAL_PROPERTY}, false) = false`,
  'RETURN id(n) AS id',
].join('\n');

const PROJECT_RELATIONSHIPS = [
  'MATCH (a:Memory)-[r]-(b:Memory)',
  `WHERE NOT type(r) IN [${BACKBONE_TYPES}]`,
  `  AND ${CURRENT('a')} AND ${CURRENT('b')}`,
  `  AND coalesce(a.${STRUCTURAL_PROPERTY}, false) = false`,
  `  AND coalesce(b.${STRUCTURAL_PROPERTY}, false) = false`,
  'RETURN id(a) AS source, id(b) AS target',
].join('\n');

export type ContentProjection = {
  readonly nodeCount: number;
  readonly relationshipCount: number;
};

/**
 * The undirected pattern in the relationship query returns each edge from both ends, which is
 * what label propagation needs: an association carries influence both ways, and a projection
 * that kept the stored direction would spread a community only downstream.
 */
export async function projectContentGraph(
  driver: Driver,
  graphName: string,
): Promise<ContentProjection> {
  const rows = await runWrite(
    driver,
    [
      'CALL gds.graph.project.cypher($graphName, $nodeQuery, $relationshipQuery)',
      'YIELD nodeCount, relationshipCount',
      'RETURN nodeCount, relationshipCount',
    ].join('\n'),
    { graphName, nodeQuery: PROJECT_NODES, relationshipQuery: PROJECT_RELATIONSHIPS },
    (row) => ({
      nodeCount: row['nodeCount'] as number,
      relationshipCount: row['relationshipCount'] as number,
    }),
  );
  return rows[0] ?? { nodeCount: 0, relationshipCount: 0 };
}

export type CommunityWriteResult = {
  readonly communityCount: number;
  readonly nodePropertiesWritten: number;
  readonly ranIterations: number;
  readonly didConverge: boolean;
};

export async function writeCommunities(
  driver: Driver,
  graphName: string,
  maxIterations: number = COMMUNITY_MAX_ITERATIONS,
): Promise<CommunityWriteResult> {
  const rows = await runWrite(
    driver,
    [
      'CALL gds.labelPropagation.write($graphName, { writeProperty: $writeProperty, maxIterations: $maxIterations })',
      'YIELD communityCount, nodePropertiesWritten, ranIterations, didConverge',
      'RETURN communityCount, nodePropertiesWritten, ranIterations, didConverge',
    ].join('\n'),
    {
      graphName,
      writeProperty: COMMUNITY_PROPERTY,
      maxIterations: toGraphInteger(maxIterations),
    },
    (row) => ({
      communityCount: row['communityCount'] as number,
      nodePropertiesWritten: row['nodePropertiesWritten'] as number,
      ranIterations: row['ranIterations'] as number,
      didConverge: row['didConverge'] === true,
    }),
  );
  return rows[0] ?? { communityCount: 0, nodePropertiesWritten: 0, ranIterations: 0, didConverge: false };
}

/**
 * `false` is the fail-if-missing argument: dropping a projection that is not there is the
 * normal case, since this runs before a project as well as after one.
 */
export async function dropProjection(driver: Driver, graphName: string): Promise<void> {
  await runWrite(
    driver,
    'CALL gds.graph.drop($graphName, false) YIELD graphName AS dropped RETURN dropped',
    { graphName },
    (row) => row['dropped'] as string,
  );
}

export type CommunityProfile = {
  readonly community: number;
  readonly size: number;
  /** Association edges from this community's members to a member of any other community. */
  readonly externalEdges: number;
};

/**
 * Communities ranked by how little joins them to the rest of the graph. The first two rows of
 * a run are the pair the bridge engine is for: large enough to be a real neighbourhood, and
 * connected to nothing much, which is the knowledge island the design describes.
 */
const READ_COMMUNITY_PROFILES = [
  'MATCH (n:Memory)',
  `WHERE ${CURRENT('n')} AND n.${COMMUNITY_PROPERTY} IS NOT NULL`,
  `  AND coalesce(n.${STRUCTURAL_PROPERTY}, false) = false`,
  `WITH n.${COMMUNITY_PROPERTY} AS community, collect(n) AS members, count(n) AS size`,
  'WHERE size >= $minSize',
  'UNWIND members AS m',
  'OPTIONAL MATCH (m)-[r]-(o:Memory)',
  `  WHERE NOT type(r) IN [${BACKBONE_TYPES}]`,
  `    AND o.${COMMUNITY_PROPERTY} IS NOT NULL AND o.${COMMUNITY_PROPERTY} <> community`,
  'RETURN community, size, count(r) AS external_edges',
  'ORDER BY external_edges ASC, size DESC, community ASC',
].join('\n');

export async function readCommunityProfiles(
  driver: Driver,
  minSize: number,
): Promise<CommunityProfile[]> {
  return runRead(driver, READ_COMMUNITY_PROFILES, { minSize: toGraphInteger(minSize) }, (row) => ({
    community: row['community'] as number,
    size: row['size'] as number,
    externalEdges: row['external_edges'] as number,
  }));
}
