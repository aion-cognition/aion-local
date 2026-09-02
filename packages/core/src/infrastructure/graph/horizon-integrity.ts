import type { Driver } from 'neo4j-driver';

import { BITEMPORAL_PROPERTIES } from './bitemporal.js';
import { readFirst } from './connection.js';
import { BASE_NODE_LABEL } from './labels.js';
import { VALID_HORIZON_PROPERTY } from './read-modes.js';
import { toGraphInteger } from './values.js';

/**
 * A reading's horizon is annotated at read and is never a close. The two properties can both
 * be present on one node for an ordinary reason: a reading a later observation corrected
 * carries the close that correction wrote alongside the horizon it was born with.
 *
 * They cannot carry the same instant. A `valid_until` stamped at the horizon is a horizon
 * written as a close, and that node has left every currency predicate in the tree without
 * anything correcting it. `coalesce` on the next real close then keeps the wrong world time
 * under a live lineage edge. Counting it is what makes the difference knowable.
 */

/** Nodes read per scan. The substrate is local and single-user; this is a ceiling, not a page. */
export const DEFAULT_HORIZON_SCAN_LIMIT = 20_000;

const SAMPLE_SIZE = 5;

export type HorizonIntegrity = {
  /** Nodes carrying a reading horizon at all, which is the population the rest counts within. */
  readonly withHorizon: number;
  /** Of those, the ones something has since closed. A corrected reading is one, and is normal. */
  readonly closed: number;
  /** Of those, the ones whose close is the horizon itself. Every one of these is broken. */
  readonly closedAtHorizon: number;
  /** Node ids, capped, so an operator has somewhere to start rather than a number. */
  readonly sampleIds: readonly string[];
};

const HORIZON_INTEGRITY = [
  `MATCH (n:${BASE_NODE_LABEL})`,
  `WHERE n.${VALID_HORIZON_PROPERTY} IS NOT NULL`,
  'WITH n LIMIT $limit',
  'WITH collect({',
  '  id: n.id,',
  `  closed: n.${BITEMPORAL_PROPERTIES.validUntil} IS NOT NULL,`,
  `  closedAtHorizon: n.${BITEMPORAL_PROPERTIES.validUntil} = n.${VALID_HORIZON_PROPERTY}`,
  '}) AS rows',
  'RETURN size(rows) AS with_horizon,',
  '       size([row IN rows WHERE row.closed]) AS closed,',
  '       size([row IN rows WHERE row.closedAtHorizon]) AS closed_at_horizon,',
  '       [row IN rows WHERE row.closedAtHorizon | row.id][0..$sample] AS samples',
].join('\n');

/**
 * What `aion doctor` reads to tell a substrate nobody ever stamped a horizon into from one
 * that was. Read-only, like every other check: repairing a node that took a horizon as its
 * close is `aion unsupersede`'s verb, not this one's.
 */
export async function scanHorizonIntegrity(
  driver: Driver,
  limit: number = DEFAULT_HORIZON_SCAN_LIMIT,
): Promise<HorizonIntegrity> {
  const report = await readFirst(
    driver,
    HORIZON_INTEGRITY,
    { limit: toGraphInteger(limit), sample: toGraphInteger(SAMPLE_SIZE) },
    (row) => ({
      withHorizon: row.with_horizon as number,
      closed: row.closed as number,
      closedAtHorizon: row.closed_at_horizon as number,
      sampleIds: (row.samples as string[] | null) ?? [],
    }),
  );
  return report ?? { withHorizon: 0, closed: 0, closedAtHorizon: 0, sampleIds: [] };
}
