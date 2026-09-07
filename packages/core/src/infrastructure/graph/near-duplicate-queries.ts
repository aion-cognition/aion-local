import type { Driver } from 'neo4j-driver';

import { edgeVisibility } from './adjacency.js';
import { CLAIM_ASPECT_PROPERTY, CLAIM_SUBJECT_PROPERTY } from './claim-key-queries.js';
import { TEXT_NORM_PROPERTY } from './cognitive-text.js';
import { runRead, type GraphStatement } from './connection.js';
import { BASE_NODE_LABEL } from './labels.js';
import { readModeFragment, type ReadMode } from './read-modes.js';
import { CONTRADICTION_TYPE, SUPERSEDES_TYPE } from './relationships.js';
import type { Row } from './values.js';

/**
 * Which of a pack's candidates are one claim recorded twice: same subject key, same stored
 * text fold, and no relationship saying the substrate holds them apart. The decision about
 * what to do with the answer is `recall/domain/pack-duplicates.ts`; nothing here writes.
 *
 * Identity of the fold, not closeness of the vectors, and that is a measurement rather than a
 * preference. Against the shipped embedding model on claim text, one sentence with a changed
 * number reads 0.997 ("retries at most 5 times" against 6), a changed day 0.993, a changed
 * retention window 0.995, while a genuine rewording of one claim reads 0.788 ("the login flow
 * moved to the edge worker" against "login now runs on the edge worker"). The two populations
 * are inverted, so no cosine separates them, and the serving path has no judge to ask. What is
 * left is the fold the substrate already stores and already keys node identity on: two nodes
 * carrying it are the same sentence, whatever else differs.
 *
 * A claim the substrate holds apart from another is never offered at all, in any pair. That is
 * the group and not the pair, because excluding only the edge itself leaves both ends free to
 * fold into a third record of the same sentence, and a reader served that third one loses the
 * disagreement entirely. `SUPERSEDES` is the close the judge wrote and `CONTRADICTS` is the
 * disagreement the relationship stage recorded; in both cases the reason to read the second
 * claim is that the substrate says it differs from the first, and that reason does not go away
 * because a third record exists. The rest of the group still folds among itself.
 *
 * Edge visibility follows the read's own vantage point, so a historical read is judged against
 * the relationships the substrate held then.
 */

export type RestatedClaimPair = {
  readonly left: string;
  readonly right: string;
};

export type RestatedClaimInput = {
  readonly ids: readonly string[];
  readonly mode: ReadMode;
};

function statement(input: RestatedClaimInput): GraphStatement {
  const fragment = readModeFragment(input.mode, 'n');
  // The edge test reuses the node fragment's own prefix, so the pinned instants a historical
  // read binds once govern the relationships as well as the nodes.
  const held = edgeVisibility(input.mode, 'r', 'rm');
  const cypher = [
    'UNWIND $ids AS wantedId',
    `MATCH (n:${BASE_NODE_LABEL} { id: wantedId })`,
    `WHERE ${fragment.where}`,
    `  AND n.${CLAIM_SUBJECT_PROPERTY} IS NOT NULL`,
    `  AND n.${CLAIM_ASPECT_PROPERTY} IS NOT NULL`,
    `  AND n.${TEXT_NORM_PROPERTY} IS NOT NULL`,
    `WITH n.${CLAIM_SUBJECT_PROPERTY} AS subject, n.${CLAIM_ASPECT_PROPERTY} AS aspect,`,
    `     n.${TEXT_NORM_PROPERTY} AS fold, collect(n) AS claims, collect(n.id) AS claimIds`,
    'WHERE size(claims) > 1',
    'UNWIND claims AS member',
    'WITH subject, aspect, fold, claimIds, member,',
    `     [ (member)-[r:${SUPERSEDES_TYPE}|${CONTRADICTION_TYPE}]-(other)`,
    `       WHERE other.id IN claimIds AND ${held} | other.id ] AS apart`,
    'WITH subject, aspect, fold,',
    '     collect(CASE WHEN size(apart) = 0 THEN member.id ELSE null END) AS members',
    'WITH [ id IN members WHERE id IS NOT NULL ] AS foldable',
    'WHERE size(foldable) > 1',
    'UNWIND foldable AS leftId',
    'UNWIND foldable AS rightId',
    'WITH leftId, rightId',
    'WHERE leftId < rightId',
    'RETURN leftId AS left, rightId AS right',
  ].join('\n');

  return { cypher, parameters: { ...fragment.parameters, ids: [...new Set(input.ids)] } };
}

function mapPair(row: Row): RestatedClaimPair {
  return { left: row.left as string, right: row.right as string };
}

/**
 * Batched like every other read recall makes against ids it already holds. A candidate set
 * holding no two claims under one key and one fold comes back empty, which is the ordinary
 * answer and the one this is expected to give most of the time.
 */
export async function restatedClaims(
  driver: Driver,
  input: RestatedClaimInput,
): Promise<RestatedClaimPair[]> {
  if (input.ids.length < 2) {
    return [];
  }
  return runRead(driver, statement(input), mapPair);
}
