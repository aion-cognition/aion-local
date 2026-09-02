import type { Driver } from 'neo4j-driver';

import { currentOnly } from './bitemporal.js';
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

const ENTITY_MERGE_PAIR_STATE = [
  `MATCH (a:${BASE_NODE_LABEL} { id: $idA }), (b:${BASE_NODE_LABEL} { id: $idB })`,
  `OPTIONAL MATCH (a)-[r:${SUPERSEDES_TYPE}]-(b)`,
  'WHERE $signal IN r.signals',
  'RETURN count(r) > 0 AS merged,',
  `       ${currentOnly('a')} AND ${currentOnly('b')} AS both_current`,
].join('\n');

export type EntityMergePairState = {
  readonly merged: boolean;
  /**
   * False once either side lost currency to anything other than a merge of this pair. A
   * resolved, unmerged pair with a side gone was cleared as stale, not turned down by anyone,
   * and the agreement read has to tell those apart or every stale clear reads as a policy
   * failure.
   */
  readonly bothCurrent: boolean;
};

export async function entityMergePairState(
  driver: Driver,
  idA: string,
  idB: string,
): Promise<EntityMergePairState> {
  const state = await readFirst(
    driver,
    ENTITY_MERGE_PAIR_STATE,
    { idA, idB, signal: ENTITY_MERGE_SUPERSEDES_SIGNAL },
    (row) => ({ merged: row.merged === true, bothCurrent: row.both_current === true }),
  );
  return state ?? { merged: false, bothCurrent: false };
}

/**
 * The stats read behind `merge_auto`'s count. Kept as a local literal rather than an import of
 * `AUTO_MERGE_METHOD`, the same way `ENTITY_MERGE_SUPERSEDES_SIGNAL` above restates
 * `entity_merge` rather than importing it: the two spellings are pinned to agree by the
 * integration test that applies a proposal and reads this count back.
 */
const AUTO_MERGE_PROVENANCE = 'auto_merge';

const COUNT_AUTO_MERGED_ENTITIES = [
  `MATCH ()-[r:${SUPERSEDES_TYPE}]->()`,
  'WHERE $provenance IN r.provenance',
  'RETURN count(r) AS count',
].join('\n');

/** How many `SUPERSEDES` edges `merge_auto` has written, for `aion stats`. */
export async function countAutoMergedEntities(driver: Driver): Promise<number> {
  const count = await readFirst(
    driver,
    COUNT_AUTO_MERGED_ENTITIES,
    { provenance: AUTO_MERGE_PROVENANCE },
    (row) => row.count as number,
  );
  return count ?? 0;
}
