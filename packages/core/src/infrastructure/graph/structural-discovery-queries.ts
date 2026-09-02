import type { Driver } from 'neo4j-driver';

import { BITEMPORAL_PROPERTIES, currentOnly } from './bitemporal.js';
import { dropProjection } from './community-queries.js';
import { readFirst, runRead, writeFirst } from './connection.js';
import { ENTITY_ALIASES_PROPERTY } from './entity-identity-queries.js';
import { ENTITY_MENTION_TYPE } from './entity-mention-queries.js';
import { MEMORY_PROPERTIES } from './episodes.js';
import { BACKBONE_TYPES, BASE_NODE_LABEL, ENTITY_LABEL } from './labels.js';
import { ENTITY_NAME_PROPERTY, STRUCTURAL_PROPERTY } from './seed-queries.js';
import { toGraphInteger } from './values.js';
import type { Logger } from '../logging/logger.js';

/**
 * The reads behind structural edge discovery: which identities the graph has barely connected,
 * which of their nearest neighbours in the embedding space are worth asking about, and what
 * each side answers to by name.
 *
 * The nomination runs through Graph Data Science rather than through the vector index because
 * the question is asked of a population rather than of one seed: every under-connected entity
 * at once, each with its own nearest neighbours, in a single pass. Nothing here writes an
 * edge, a property, or a decision. A cosine reaches the caller as a number attached to a pair,
 * and the caller has evidence to gather before any of it means anything.
 *
 * Projection discipline follows community refresh's, for community refresh's reasons: one
 * static name so an abandoned projection is reclaimed rather than accumulated, a reclaim
 * before the build in case a previous run died between project and drop, and a drop in a
 * finally so a failure partway leaves the plugin's catalog as it found it.
 */

/** One name, no timestamp in it. A timestamped name leaks a projection per run. */
export const ENTITY_VECTOR_PROJECTION_NAME = 'aion-entity-vectors';

/**
 * Neighbours per node the algorithm keeps. Deliberately under the shared-episode nominator's
 * ten: an under-connected entity that needs five candidates to find one the graph seconds is
 * an entity the graph has nothing to say about.
 */
export const DISCOVERY_TOP_K = 5;

/** A tick's ceiling on nominated pairs, so one dense substrate cannot hand a run a day's work. */
export const DISCOVERY_NOMINATION_LIMIT = 100;

/**
 * Exhaustive rather than sampled. kNN is approximate by default, so two runs over one
 * unchanged substrate can nominate two different sets; at this population the full comparison
 * costs little and a nomination that changes under a re-read is not one anything can reason
 * about.
 */
const DISCOVERY_SAMPLE_RATE = 1;

/**
 * An association is an edge between two memories that neither the backbone nor a mention
 * accounts for. Mentions are excluded because an entity named in forty episodes is well
 * mentioned and no better connected for it, which is the whole population this looks for.
 */
function associationEdge(variable: string): string {
  return [
    `NOT type(${variable}) IN [${BACKBONE_TYPES}]`,
    `type(${variable}) <> '${ENTITY_MENTION_TYPE}'`,
    `${variable}.${BITEMPORAL_PROPERTIES.validUntil} IS NULL`,
  ].join(' AND ');
}

/** The entities the projection carries: current, content-bearing, and not the backbone. */
const PROJECTABLE_ENTITY = [
  currentOnly('n'),
  `coalesce(n.${STRUCTURAL_PROPERTY}, false) = false`,
  `n.${MEMORY_PROPERTIES.contentVector} IS NOT NULL`,
].join(' AND ');

/**
 * Whether the plugin is loaded at all. The image ships it, but a server someone started by
 * hand may not, and a nominator that cannot run has to say so rather than fail the caller.
 */
export async function knnAvailable(driver: Driver): Promise<boolean> {
  const count = await readFirst(
    driver,
    "SHOW PROCEDURES YIELD name WHERE name = 'gds.knn.stream' RETURN count(*) AS count",
    {},
    (row) => row.count as number,
  );
  return (count ?? 0) > 0;
}

const COUNT_PROJECTABLE_ENTITIES = [
  `MATCH (n:${ENTITY_LABEL})`,
  `WHERE ${PROJECTABLE_ENTITY}`,
  'RETURN count(n) AS count',
].join('\n');

/**
 * The size of the projection before it is built. The bound is a refusal above the cap rather
 * than a truncation, the same rule community refresh takes: a projection built over part of
 * the population answers about a graph that does not exist.
 */
export async function countProjectableEntities(driver: Driver): Promise<number> {
  const count = await readFirst(
    driver,
    COUNT_PROJECTABLE_ENTITIES,
    {},
    (row) => row.count as number,
  );
  return count ?? 0;
}

export type LowDegreeEntity = {
  readonly id: string;
  /** Open association edges onto the identity, mentions and backbone excluded. */
  readonly associationDegree: number;
};

const FIND_LOW_DEGREE_ENTITIES = [
  `MATCH (n:${ENTITY_LABEL})`,
  `WHERE ${PROJECTABLE_ENTITY}`,
  `OPTIONAL MATCH (n)-[r]-(o:${BASE_NODE_LABEL})`,
  `  WHERE ${associationEdge('r')} AND ${currentOnly('o')}`,
  'WITH n, count(r) AS degree',
  'WHERE degree <= $ceiling',
  'RETURN n.id AS id, degree',
  'ORDER BY degree ASC, id ASC',
  'LIMIT $limit',
].join('\n');

export type LowDegreeOptions = {
  /** Association edges an identity may already hold and still count as under-connected. */
  readonly degreeCeiling: number;
  readonly limit: number;
};

export async function findLowDegreeEntities(
  driver: Driver,
  options: LowDegreeOptions,
): Promise<LowDegreeEntity[]> {
  return runRead(
    driver,
    FIND_LOW_DEGREE_ENTITIES,
    {
      ceiling: toGraphInteger(options.degreeCeiling),
      limit: toGraphInteger(options.limit),
    },
    (row) => ({
      id: row.id as string,
      associationDegree: row.degree as number,
    }),
  );
}

const PROJECT_NODES = [
  `MATCH (n:${ENTITY_LABEL})`,
  `WHERE ${PROJECTABLE_ENTITY}`,
  `RETURN id(n) AS id, n.${MEMORY_PROPERTIES.contentVector} AS ${MEMORY_PROPERTIES.contentVector}`,
].join('\n');

/**
 * kNN compares nodes by their properties and walks no edges, so the projection carries none.
 * The clause still has to return the two columns the projection expects, which is what the
 * false predicate leaves empty.
 */
const PROJECT_RELATIONSHIPS = [
  `MATCH (n:${ENTITY_LABEL})`,
  'WHERE false',
  'RETURN id(n) AS source, id(n) AS target',
].join('\n');

export type EntityVectorProjection = {
  readonly nodeCount: number;
};

export async function projectEntityVectors(
  driver: Driver,
  graphName: string,
): Promise<EntityVectorProjection> {
  const projection = await writeFirst(
    driver,
    [
      'CALL gds.graph.project.cypher($graphName, $nodeQuery, $relationshipQuery)',
      'YIELD nodeCount',
      'RETURN nodeCount',
    ].join('\n'),
    { graphName, nodeQuery: PROJECT_NODES, relationshipQuery: PROJECT_RELATIONSHIPS },
    (row) => ({ nodeCount: row.nodeCount as number }),
  );
  return projection ?? { nodeCount: 0 };
}

export type VectorNomination = {
  readonly leftId: string;
  readonly rightId: string;
  /** A true cosine, which is why the whole rest of the operation exists: it nominates only. */
  readonly cosine: number;
};

/**
 * `a.id < b.id` is what makes a nomination one row: the algorithm emits a pair from both ends,
 * and the sweep wants the pair once, in the id order its edge is normalized to.
 *
 * A pair the graph already joins is filtered here rather than after the fact. It is not a
 * discovery: whatever an edge between them would say, the substrate already says.
 */
const STREAM_NOMINATIONS = [
  'CALL gds.knn.stream($graphName, {',
  `  nodeProperties: { ${MEMORY_PROPERTIES.contentVector}: 'COSINE' },`,
  '  topK: $topK,',
  '  similarityCutoff: $floor,',
  `  sampleRate: ${String(DISCOVERY_SAMPLE_RATE)},`,
  '  concurrency: 1',
  '})',
  'YIELD node1, node2, similarity',
  'WITH gds.util.asNode(node1) AS a, gds.util.asNode(node2) AS b, similarity',
  `WHERE a:${ENTITY_LABEL} AND b:${ENTITY_LABEL} AND a.id < b.id`,
  '  AND (a.id IN $seedIds OR b.id IN $seedIds)',
  `  AND NOT EXISTS { MATCH (a)-[r]-(b) WHERE ${associationEdge('r')} }`,
  'RETURN a.id AS left_id, b.id AS right_id, similarity',
  'ORDER BY similarity DESC, left_id, right_id',
  'LIMIT $limit',
].join('\n');

export type NominationOptions = {
  /** The under-connected identities a nomination has to touch at least one of. */
  readonly seedIds: readonly string[];
  /** The cosine a pair reaches before it is worth gathering evidence about. Nomination only. */
  readonly cosineFloor: number;
  readonly topK?: number;
  readonly limit?: number;
  /** Takes the drop failure a leaked projection reports. A leak is not the caller's failure. */
  readonly logger?: Logger;
};

export type NominationResult =
  | { readonly status: 'unavailable' }
  | {
      readonly status: 'ok';
      readonly nominations: readonly VectorNomination[];
      readonly nodeCount: number;
    };

/** A projection left behind is a leak, not a failure; the next run reclaims the name anyway. */
async function dropQuietly(driver: Driver, logger: Logger | undefined): Promise<void> {
  try {
    await dropProjection(driver, ENTITY_VECTOR_PROJECTION_NAME);
  } catch (err) {
    logger?.warn(
      { err, graphName: ENTITY_VECTOR_PROJECTION_NAME },
      'entity vector projection drop failed',
    );
  }
}

/**
 * Guard, reclaim, project, stream, drop. The caller gets the pairs and never the projection,
 * so there is no path on which forgetting to drop is possible. Population bounds stay with the
 * operation that calls this.
 */
export async function nominateVectorNeighbors(
  driver: Driver,
  options: NominationOptions,
): Promise<NominationResult> {
  if (options.seedIds.length === 0) {
    return { status: 'ok', nominations: [], nodeCount: 0 };
  }
  if (!(await knnAvailable(driver))) {
    return { status: 'unavailable' };
  }

  await dropQuietly(driver, options.logger);
  try {
    const projection = await projectEntityVectors(driver, ENTITY_VECTOR_PROJECTION_NAME);
    if (projection.nodeCount < 2) {
      return { status: 'ok', nominations: [], nodeCount: projection.nodeCount };
    }
    const nominations = await runRead(
      driver,
      STREAM_NOMINATIONS,
      {
        graphName: ENTITY_VECTOR_PROJECTION_NAME,
        seedIds: [...options.seedIds],
        floor: options.cosineFloor,
        topK: toGraphInteger(options.topK ?? DISCOVERY_TOP_K),
        limit: toGraphInteger(options.limit ?? DISCOVERY_NOMINATION_LIMIT),
      },
      (row) => ({
        leftId: row.left_id as string,
        rightId: row.right_id as string,
        cosine: row.similarity as number,
      }),
    );
    return { status: 'ok', nominations, nodeCount: projection.nodeCount };
  } finally {
    await dropQuietly(driver, options.logger);
  }
}

export type EntityNameForms = {
  readonly id: string;
  /** The identity's own name first, then every spelling it answers to. */
  readonly forms: readonly string[];
};

const READ_ENTITY_NAME_FORMS = [
  'UNWIND $ids AS wantedId',
  `MATCH (n:${ENTITY_LABEL} { id: wantedId })`,
  `WHERE ${currentOnly('n')}`,
  `RETURN n.id AS id, n.${ENTITY_NAME_PROPERTY} AS name,`,
  `       coalesce(n.${ENTITY_ALIASES_PROPERTY}, []) AS aliases`,
].join('\n');

/**
 * What each side answers to, for the name arm of the seconding rule. An identity absent from
 * the answer lost currency between the nomination and this read, which is not the same as an
 * identity with no aliases.
 */
export async function readEntityNameForms(
  driver: Driver,
  ids: readonly string[],
): Promise<EntityNameForms[]> {
  if (ids.length === 0) {
    return [];
  }
  return runRead(driver, READ_ENTITY_NAME_FORMS, { ids: [...new Set(ids)] }, (row) => ({
    id: row.id as string,
    forms: [
      ...(typeof row.name === 'string' ? [row.name] : []),
      ...((row.aliases as string[] | null) ?? []),
    ],
  }));
}
