import type { Driver } from 'neo4j-driver';

import { BITEMPORAL_PROPERTIES } from './bitemporal.js';
import { runRead, type GraphStatement } from './connection.js';
import { ENTITY_MENTION_TYPE } from './entity-queries.js';
import { BASE_NODE_LABEL } from './labels.js';
import { readModeFragment, withCurrency } from './read-modes.js';

/**
 * The structure one episode produced, which is the set reflection co-occurrence reinforces
 * pairwise.
 *
 * The two edge types are the provenance the extraction stages write, and they are the whole
 * definition of "extracted from this episode": `MENTIONS` for entities, `EXTRACTED_FROM` for
 * cognitive nodes. `PARTICIPATES_IN` is deliberately not among them even though the entity
 * stage writes it: it is the containment type, so intake's Turn→Episode links match it too,
 * and reading it here sweeps every turn of the episode into the pair set. That makes the
 * queue quadratic in turn count rather than in extracted structure, and Turn↔Turn and
 * Turn↔Entity pairs are not reinforcement triggers. Nothing is lost by dropping it: the
 * entity stage writes both edges in one transaction, so `MENTIONS` covers the same entities.
 */
const CO_EXTRACTED_EDGE_TYPES = `${ENTITY_MENTION_TYPE}|EXTRACTED_FROM`;

/**
 * Anchored on the episode and expanded, like every sibling read in the pipeline. Matching
 * `(n:AionNode)` in its own clause plans as a label scan over the whole substrate on every
 * reflection run, so its cost would grow with everything ever stored rather than with the
 * episode being reflected.
 */
function coExtractedNodesStatement(episodeId: string): GraphStatement {
  const fragment = readModeFragment(withCurrency(), 'n');
  return {
    cypher: [
      'MATCH (e:Episode { id: $episodeId })',
      `MATCH (e)-[:${CO_EXTRACTED_EDGE_TYPES}]-(n:${BASE_NODE_LABEL})`,
      `WHERE n.${BITEMPORAL_PROPERTIES.validUntil} IS NULL AND ${fragment.where}`,
      'RETURN DISTINCT n.id AS id',
    ].join('\n'),
    parameters: { episodeId, ...fragment.parameters },
  };
}

/**
 * The current entities and cognitive nodes this episode produced. A node a later stage
 * closed (a merged-away duplicate, a superseded fact) is excluded: reinforcing an edge
 * onto it would strengthen a path recall no longer treats as the identity.
 */
export async function findCoExtractedNodeIds(
  driver: Driver,
  episodeId: string,
): Promise<readonly string[]> {
  const statement = coExtractedNodesStatement(episodeId);
  return runRead(driver, statement.cypher, statement.parameters, (row) => row.id as string);
}
