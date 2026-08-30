import type { Driver } from 'neo4j-driver';

import { runWriteWithCounters, type GraphStatement } from './connection.js';
import { BASE_NODE_LABEL } from './labels.js';
import { LAST_ACCESSED_PROPERTY } from './seed-queries.js';
import { toGraphDateTime } from './values.js';

/**
 * Recall's access-tracking side effect: every node a recall surfaced gets its last-access
 * timestamp bumped and its access count incremented, in one statement for the whole batch.
 * This is what lets `graph/seed-queries.ts`'s recency strategy leave its cold-start
 * `tx_from DESC` ordering once a substrate has served real recalls: before any recall runs,
 * no node carries either property.
 *
 * Unlike the rest of this directory's writes, this one is not idempotent by design: running
 * it twice for the same node doubles `access_count`, the same way the edge upsert's `count`
 * field sums rather than replaces (`graph/edges.ts`). Each call is meant to represent one
 * real recall, not a replay of the same operation.
 */

export const ACCESS_COUNT_PROPERTY = 'access_count';

const RECORD_ACCESS = [
  'UNWIND $ids AS nodeId',
  `MATCH (n:${BASE_NODE_LABEL} { id: nodeId })`,
  `SET n.${LAST_ACCESSED_PROPERTY} = $now,`,
  `    n.${ACCESS_COUNT_PROPERTY} = coalesce(n.${ACCESS_COUNT_PROPERTY}, 0) + 1`,
].join('\n');

export type RecordAccessInput = {
  readonly ids: readonly string[];
  readonly now: Date;
};

/** Pure statement builder, so the batch's shape is testable without a server. */
export function buildRecordAccessStatement(input: RecordAccessInput): GraphStatement {
  return {
    cypher: RECORD_ACCESS,
    parameters: { ids: [...new Set(input.ids)], now: toGraphDateTime(input.now) },
  };
}

/**
 * One round trip for the whole surfaced set, not one write per node. A no-op id list skips
 * the call entirely rather than sending Neo4j an empty `UNWIND`.
 */
export async function recordAccess(driver: Driver, input: RecordAccessInput): Promise<number> {
  if (input.ids.length === 0) {
    return 0;
  }
  const statement = buildRecordAccessStatement(input);
  const outcome = await runWriteWithCounters(
    driver,
    statement.cypher,
    statement.parameters,
    () => undefined,
  );
  return outcome.propertiesSet;
}
