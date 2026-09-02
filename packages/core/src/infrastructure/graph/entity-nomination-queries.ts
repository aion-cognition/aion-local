import type { Driver } from 'neo4j-driver';

import { currentOnly } from './bitemporal.js';
import { dropProjection } from './community-queries.js';
import { readFirst, runRead, writeFirst } from './connection.js';
import { ENTITY_MENTION_TYPE } from './entity-mention-queries.js';
import { ENTITY_LABEL } from './labels.js';
import { STRUCTURAL_PROPERTY } from './seed-queries.js';
import { toGraphInteger } from './values.js';
import type { Logger } from '../logging/logger.js';

/**
 * The cascade's second nominator. One GDS pass over an Entity-Episode projection answers, for
 * the whole graph at once, which entities were seen in the same episodes and how much of their
 * history they share. Two names never compared by a vector search reach the cascade this way,
 * which is the shape of duplicate a name-vector nominator alone cannot see.
 *
 * It nominates. It writes no edge, no property, and no decision. The similarity it returns is
 * set overlap over provenance, not a claim about identity, and the evidence tiers behind it are
 * what decide whether two nominated names are one thing.
 *
 * Projection discipline is community refresh's, for community refresh's reasons: one static
 * name so an abandoned projection is reclaimed rather than accumulated, a reclaim before the
 * build in case a previous run died between project and drop, and a drop in a finally so a
 * failure partway leaves the plugin's catalog as it found it.
 */

/** One name, no timestamp in it, reused every run. A timestamped name leaks a projection per run. */
export const ENTITY_MENTION_PROJECTION_NAME = 'aion-entity-mentions';

/**
 * Neighbours per node the algorithm keeps. GDS's own default; at local scale an entity with
 * more than ten genuine co-mention partners above the floor is a hub, and a hub's eleventh
 * partner is not the duplicate anyone is looking for.
 */
const NOMINATION_TOP_K = 10;

/** A tick's ceiling on nominated pairs, so one dense graph cannot hand the cascade a day's work. */
const NOMINATION_LIMIT = 500;

/**
 * Whether the plugin is loaded at all. The image ships it, but a server someone started by hand
 * may not, and a nominator that cannot run has to say so rather than fail the caller.
 */
export async function nodeSimilarityAvailable(driver: Driver): Promise<boolean> {
  const count = await readFirst(
    driver,
    "SHOW PROCEDURES YIELD name WHERE name = 'gds.nodeSimilarity.stream' RETURN count(*) AS count",
    {},
    (row) => row.count as number,
  );
  return (count ?? 0) > 0;
}

const PROJECT_NODES = [
  `MATCH (n:${ENTITY_LABEL})`,
  `WHERE ${currentOnly('n')} AND coalesce(n.${STRUCTURAL_PROPERTY}, false) = false`,
  'RETURN id(n) AS id',
  'UNION',
  'MATCH (e:Episode)',
  `WHERE ${currentOnly('e')}`,
  'RETURN id(e) AS id',
].join('\n');

/**
 * Reversed from how the edge is stored. `MENTIONS` runs episode to entity, and node similarity
 * compares nodes by what they point at, so an entity with no outgoing edge in the projection is
 * never a source and never gets compared to anything.
 */
const PROJECT_RELATIONSHIPS = [
  `MATCH (e:Episode)-[:${ENTITY_MENTION_TYPE}]->(n:${ENTITY_LABEL})`,
  `WHERE ${currentOnly('e')} AND ${currentOnly('n')}`,
  `  AND coalesce(n.${STRUCTURAL_PROPERTY}, false) = false`,
  'RETURN id(n) AS source, id(e) AS target',
].join('\n');

export type EntityMentionProjection = {
  readonly nodeCount: number;
  readonly relationshipCount: number;
};

export async function projectEntityMentions(
  driver: Driver,
  graphName: string,
): Promise<EntityMentionProjection> {
  const projection = await writeFirst(
    driver,
    [
      'CALL gds.graph.project.cypher($graphName, $nodeQuery, $relationshipQuery)',
      'YIELD nodeCount, relationshipCount',
      'RETURN nodeCount, relationshipCount',
    ].join('\n'),
    { graphName, nodeQuery: PROJECT_NODES, relationshipQuery: PROJECT_RELATIONSHIPS },
    (row) => ({
      nodeCount: row.nodeCount as number,
      relationshipCount: row.relationshipCount as number,
    }),
  );
  return projection ?? { nodeCount: 0, relationshipCount: 0 };
}

export type EntityNomination = {
  readonly leftId: string;
  readonly rightId: string;
  /** GDS's default metric on this call is Jaccard, which over an episode set is exactly the signal. */
  readonly sharedEpisodeJaccard: number;
};

/**
 * `a.id < b.id` is what makes a nomination one row: the algorithm emits a pair from both ends,
 * and the cascade wants the pair once, in the same id order its decision record is keyed on.
 * The label guard is belt and braces, since only entities have outgoing edges here.
 */
const STREAM_NOMINATIONS = [
  'CALL gds.nodeSimilarity.stream($graphName, { similarityCutoff: $floor, topK: $topK })',
  'YIELD node1, node2, similarity',
  'WITH gds.util.asNode(node1) AS a, gds.util.asNode(node2) AS b, similarity',
  `WHERE a:${ENTITY_LABEL} AND b:${ENTITY_LABEL} AND a.id < b.id`,
  'RETURN a.id AS left_id, b.id AS right_id, similarity',
  'ORDER BY similarity DESC, left_id, right_id',
  'LIMIT $limit',
].join('\n');

export type StreamNominationsOptions = {
  readonly jaccardFloor: number;
  readonly topK?: number;
  readonly limit?: number;
};

export async function streamEntityNominations(
  driver: Driver,
  graphName: string,
  options: StreamNominationsOptions,
): Promise<EntityNomination[]> {
  return runRead(
    driver,
    STREAM_NOMINATIONS,
    {
      graphName,
      floor: options.jaccardFloor,
      topK: toGraphInteger(options.topK ?? NOMINATION_TOP_K),
      limit: toGraphInteger(options.limit ?? NOMINATION_LIMIT),
    },
    (row) => ({
      leftId: row.left_id as string,
      rightId: row.right_id as string,
      sharedEpisodeJaccard: row.similarity as number,
    }),
  );
}

export type NominationOptions = StreamNominationsOptions & {
  /** Takes the drop failure a leaked projection reports. A leak is not the caller's failure. */
  readonly logger?: Logger;
};

export type NominationResult =
  | { readonly status: 'unavailable' }
  | {
      readonly status: 'ok';
      readonly nominations: readonly EntityNomination[];
      readonly nodeCount: number;
      readonly relationshipCount: number;
    };

/** A projection left behind is a leak, not a failure; the next run reclaims the name anyway. */
async function dropQuietly(driver: Driver, logger: Logger | undefined): Promise<void> {
  try {
    await dropProjection(driver, ENTITY_MENTION_PROJECTION_NAME);
  } catch (err) {
    logger?.warn(
      { err, graphName: ENTITY_MENTION_PROJECTION_NAME },
      'entity nomination projection drop failed',
    );
  }
}

/**
 * Guard, reclaim, project, stream, drop. The caller gets the pairs and never the projection, so
 * there is no path on which forgetting to drop is possible. The two bounds on how much one run
 * hands back, `NOMINATION_TOP_K` and `NOMINATION_LIMIT`, are this module's own: the cascade
 * passes neither, and the caps it does read from config bound what it then does with the pairs.
 */
export async function nominateSharedEpisodePairs(
  driver: Driver,
  options: NominationOptions,
): Promise<NominationResult> {
  if (!(await nodeSimilarityAvailable(driver))) {
    return { status: 'unavailable' };
  }

  await dropQuietly(driver, options.logger);
  try {
    const projection = await projectEntityMentions(driver, ENTITY_MENTION_PROJECTION_NAME);
    if (projection.relationshipCount === 0) {
      return { status: 'ok', nominations: [], ...projection };
    }
    const nominations = await streamEntityNominations(
      driver,
      ENTITY_MENTION_PROJECTION_NAME,
      options,
    );
    return { status: 'ok', nominations, ...projection };
  } finally {
    await dropQuietly(driver, options.logger);
  }
}
