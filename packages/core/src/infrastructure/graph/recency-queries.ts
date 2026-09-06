import type { Driver } from 'neo4j-driver';

import { BITEMPORAL_PROPERTIES } from './bitemporal.js';
import { runRead } from './connection.js';
import { MEMORY_LABEL } from './labels.js';
import { originPredicates } from './origin-queries.js';
import { readModeFragment, type ReadMode } from './read-modes.js';
import {
  candidateProjection,
  mapCandidate,
  LAST_ACCESSED_PROPERTY,
  type SeedCandidate,
} from './seed-queries.js';
import { toGraphInteger } from './values.js';

/**
 * The recency seed strategy, in its own file because it is the one strategy that takes the
 * asking session as an input. The other four ask what matches a cue; this one asks what the
 * substrate touched last, and on a graph where one session writes most of what it later reads
 * that question answers with the session's own transcript unless provenance is part of the
 * ordering.
 */

export type RecencySeedInput = {
  readonly limit: number;
  readonly mode: ReadMode;
  /**
   * The asking session, when the caller wants its own record ranked last. Absent leaves the
   * ordering on the two recency tiers alone, which is what a historical read and a caller
   * inspecting its own session both want.
   */
  readonly sessionId?: string;
};

/**
 * Ordering, not filtering: a memory only this session produced still seeds, it just sits
 * behind everything with a source outside the session. `LIMIT` is what makes that matter, since
 * the leg reads the whole budget and a conversation long enough fills it with its own turns and
 * the claims extracted from them, leaving the spread nothing else to start from.
 *
 * A node with no attributable provenance counts as another session's, the same way the origin
 * subtraction counts it: withholding a memory the asker never saw costs the answer.
 *
 * The predicate runs over the scan rather than over the page, because the sort is what it is
 * for. That makes an already scan-bound strategy heavier by two existence checks per entity;
 * the checks are guarded by the label test, so every other node type pays for the property
 * comparison alone.
 */
function ownershipTier(sessionId: string | undefined): readonly string[] {
  if (sessionId === undefined) {
    return [];
  }
  const origin = originPredicates('n', '$sessionId');
  return [
    `WITH n, ${origin.own} AS own,`,
    `        ${origin.other} AS other`,
    'ORDER BY CASE WHEN own AND NOT other THEN 1 ELSE 0 END,',
  ];
}

/**
 * Rows come back newest-first and unscored; the caller turns position into a score, because
 * recency is an ordering, not a measurement.
 *
 * Two-tier ordering rather than a coalesce: nodes that have actually been recalled outrank
 * nodes that are merely new. On a substrate that has served no recalls nothing carries
 * `last_accessed`, the first tier is empty, and the whole ordering degrades to `tx_from`
 * DESC. Ranking policy, not text machinery: both tiers answer "recently relevant".
 *
 * No index covers either ordering key, so this sorts a `:Memory` scan. Bounded by `LIMIT` and
 * by a single-user graph; it is the one seed strategy whose cost grows with total memory.
 */
export async function recencySeeds(
  driver: Driver,
  input: RecencySeedInput,
): Promise<SeedCandidate[]> {
  const fragment = readModeFragment(input.mode, 'n');
  const ownership = ownershipTier(input.sessionId);
  const cypher = [
    `MATCH (n:${MEMORY_LABEL})`,
    `WHERE ${fragment.where}`,
    ...(ownership.length === 0 ? ['WITH n', 'ORDER BY'] : ownership),
    `         CASE WHEN n.${LAST_ACCESSED_PROPERTY} IS NULL THEN 1 ELSE 0 END,`,
    `         n.${LAST_ACCESSED_PROPERTY} DESC,`,
    `         n.${BITEMPORAL_PROPERTIES.txFrom} DESC`,
    'LIMIT $limit',
    `RETURN ${candidateProjection('n', fragment)}`,
  ].join('\n');

  return runRead(
    driver,
    cypher,
    {
      ...fragment.parameters,
      limit: toGraphInteger(input.limit),
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    },
    mapCandidate,
  );
}
