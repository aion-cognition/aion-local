import type { Driver } from 'neo4j-driver';

import { CLAIM_ASPECT_PROPERTY, CLAIM_SUBJECT_PROPERTY } from './claim-key-queries.js';
import { runRead, type GraphStatement } from './connection.js';
import { MEMORY_PROPERTIES } from './episodes.js';
import { BASE_NODE_LABEL } from './labels.js';
import { readModeFragment, type ReadMode } from './read-modes.js';
import { SUPERSEDES_TYPE } from './relationships.js';
import type { Row } from './values.js';
import { asCosine, capScore } from './vector-indexes.js';

/**
 * How close two of a pack's candidates are, for the pairs that assert the same attribute of the
 * same entity. The serving layer asks this to decide whether to print one assertion twice; the
 * decision itself is `recall/domain/pack-duplicates.ts`, and nothing here writes anything.
 *
 * The comparison is made in the database rather than in the pipeline. Only the pairs sharing a
 * claim key can be duplicates at all, and there are few of those among a pack's candidates, so
 * asking the graph for the cosines costs a handful of numbers where pulling the vectors out to
 * compare them here would cost a full embedding per candidate.
 *
 * A pair the judge already closed is not returned: `SUPERSEDES` says the substrate holds one of
 * the two to be the correction of the other, which is the whole reason to read the second one.
 * A correction somebody merely stated is a different shape, an edge from the episode that
 * stated it rather than between the two claims, so `pack-duplicates.ts` refuses those from the
 * provenance record instead.
 */

export type ClaimSimilarity = {
  readonly left: string;
  readonly right: string;
  /** A true cosine on [-1,1], rescaled back from what Neo4j reports and capped at 1. */
  readonly similarity: number;
};

export type ClaimSimilarityInput = {
  readonly ids: readonly string[];
  readonly mode: ReadMode;
};

const VECTOR = MEMORY_PROPERTIES.contentVector;

function statement(input: ClaimSimilarityInput): GraphStatement {
  const fragment = readModeFragment(input.mode, 'n');
  const cypher = [
    'UNWIND $ids AS wantedId',
    `MATCH (n:${BASE_NODE_LABEL} { id: wantedId })`,
    `WHERE ${fragment.where}`,
    `  AND n.${CLAIM_SUBJECT_PROPERTY} IS NOT NULL`,
    `  AND n.${CLAIM_ASPECT_PROPERTY} IS NOT NULL`,
    `  AND n.${VECTOR} IS NOT NULL`,
    `WITH n.${CLAIM_SUBJECT_PROPERTY} AS subject, n.${CLAIM_ASPECT_PROPERTY} AS aspect,`,
    '     collect(n) AS keyed',
    'WHERE size(keyed) > 1',
    'UNWIND keyed AS a',
    'UNWIND keyed AS b',
    'WITH a, b',
    'WHERE a.id < b.id',
    `  AND NOT EXISTS { MATCH (a)-[:${SUPERSEDES_TYPE}]-(b) }`,
    'RETURN a.id AS left, b.id AS right,',
    `       ${asCosine(`vector.similarity.cosine(a.${VECTOR}, b.${VECTOR})`)} AS similarity`,
  ].join('\n');

  return { cypher, parameters: { ...fragment.parameters, ids: [...new Set(input.ids)] } };
}

function mapSimilarity(row: Row): ClaimSimilarity {
  return {
    left: row.left as string,
    right: row.right as string,
    similarity: capScore(row.similarity as number),
  };
}

/**
 * Batched like every other read recall makes against ids it already holds. A candidate set with
 * no two keyed claims in it comes back empty, which is the ordinary answer.
 */
export async function claimSimilarities(
  driver: Driver,
  input: ClaimSimilarityInput,
): Promise<ClaimSimilarity[]> {
  if (input.ids.length < 2) {
    return [];
  }
  return runRead(driver, statement(input), mapSimilarity);
}
