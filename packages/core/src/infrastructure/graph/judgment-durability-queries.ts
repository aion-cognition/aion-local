import type { Driver } from 'neo4j-driver';

import { runRead } from './connection.js';
import { BASE_NODE_LABEL } from './labels.js';
import { SUPERSEDES_TYPE } from './relationships.js';
import { toGraphInteger, type Row } from './values.js';

/**
 * One SUPERSEDES lineage edge's durability reading: the edge itself is the record. `unreversed`
 * is `r.tx_until IS NULL`, the exact predicate `unsupersede.ts`'s reopen clears; a `false` here
 * means somebody ran a reopen against the closed node this edge points at. `provenance` is
 * whatever the writer that made the close stamped, already stored and never invented here: the
 * contradiction judge, subject-family propagation, episode propagation and a manual `supersede`
 * default all write their own tag, and this reads it back rather than adding a parallel ledger.
 */
export type SupersedesLineageRow = {
  readonly provenance: readonly string[];
  readonly unreversed: boolean;
  readonly createdAt: Date | undefined;
  readonly reopenedAt: Date | undefined;
};

const DEFAULT_SCAN_LIMIT = 5_000;

/**
 * Every SUPERSEDES edge, most recent first, capped at `limit`. A scan under the true edge count
 * on a large substrate names that in its own summary rather than silently reading a partial
 * population as the whole one; this function only returns the rows, the caller states the cap.
 */
export async function listSupersedesLineage(
  driver: Driver,
  limit: number = DEFAULT_SCAN_LIMIT,
): Promise<readonly SupersedesLineageRow[]> {
  const cypher = [
    `MATCH (:${BASE_NODE_LABEL})-[r:${SUPERSEDES_TYPE}]->(:${BASE_NODE_LABEL})`,
    'RETURN coalesce(r.provenance, []) AS provenance,',
    '       r.tx_until IS NULL AS unreversed,',
    '       r.created_at AS created_at,',
    '       r.reopened_at AS reopened_at',
    'ORDER BY r.created_at DESC',
    'LIMIT $limit',
  ].join('\n');
  return runRead(driver, cypher, { limit: toGraphInteger(limit) }, mapRow);
}

function mapRow(row: Row): SupersedesLineageRow {
  return {
    provenance: (row.provenance as string[] | null) ?? [],
    unreversed: row.unreversed === true,
    createdAt: row.created_at instanceof Date ? row.created_at : undefined,
    reopenedAt: row.reopened_at instanceof Date ? row.reopened_at : undefined,
  };
}
