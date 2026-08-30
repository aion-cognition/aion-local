import type { Driver } from 'neo4j-driver';

import { readFirst } from './connection.js';
import { BASE_NODE_LABEL } from './labels.js';
import { SUPERSEDES_TYPE } from './relationships.js';

/**
 * The actual-outcome read behind the merge-shadow agreement in `aion stats`. A resolved
 * proposal's row never says whether the pair actually merged, only that a person closed it, so
 * the answer has to come from the graph: a merge, whichever side absorbed the other, leaves a
 * `SUPERSEDES` edge carrying the `entity_merge` signal (`entity-merge-review.ts` and the dedup
 * stage's own auto-merge both write it). Matched undirected because either side could be the
 * canonical one; a resolved row with no such edge either way was dismissed, or went stale.
 */

const ENTITY_MERGE_SUPERSEDES_SIGNAL = 'entity_merge';

const ENTITY_MERGE_APPLIED = [
  `MATCH (a:${BASE_NODE_LABEL} { id: $idA })-[r:${SUPERSEDES_TYPE}]-(b:${BASE_NODE_LABEL} { id: $idB })`,
  'WHERE $signal IN r.signals',
  'RETURN count(r) > 0 AS applied',
].join('\n');

export async function wasEntityMergeApplied(
  driver: Driver,
  idA: string,
  idB: string,
): Promise<boolean> {
  const applied = await readFirst(
    driver,
    ENTITY_MERGE_APPLIED,
    { idA, idB, signal: ENTITY_MERGE_SUPERSEDES_SIGNAL },
    (row) => row.applied as boolean,
  );
  return applied === true;
}
