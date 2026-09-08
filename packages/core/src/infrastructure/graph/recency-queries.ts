import type { Driver } from 'neo4j-driver';

import { BITEMPORAL_PROPERTIES } from './bitemporal.js';
import { runRead } from './connection.js';
import { MEMORY_LABEL } from './labels.js';
import { orderedPublicationSequence, ownOnlyDiscount } from './ownership-summary-queries.js';
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

/**
 * The asking session and the bound its summaries are trusted up to. The caller reads the bound
 * from the publication control record before nomination runs; an absent one leaves every
 * candidate on the recency tiers alone.
 */
export type RecencyOwnership = {
  readonly sessionId: string;
  readonly substrateId: string;
  /** The last acknowledged publication sequence, as decimal text. */
  readonly acknowledgedSequence: string;
};

export type RecencySeedInput = {
  readonly limit: number;
  readonly mode: ReadMode;
  /**
   * The asking session and its trust bound, when the caller wants its own record ranked last.
   * Absent leaves the ordering on the two recency tiers alone, which is what a historical read
   * and a caller inspecting its own session both want.
   */
  readonly ownership?: RecencyOwnership;
};

/**
 * Ordering, not filtering: a memory only this session produced still seeds, it just sits
 * behind everything with a source outside the session. `LIMIT` is what makes that matter, since
 * the leg reads the whole budget and a conversation long enough fills it with its own turns and
 * the claims extracted from them, leaving the spread nothing else to start from.
 *
 * A node whose ownership summary is missing, unproved, uncounted or written by another substrate
 * takes no discount at all. Preserving an extra candidate costs the ordering; discounting one on
 * an unproved reading costs the answer a memory, and post-query certification cannot recover a
 * candidate the limit already dropped.
 *
 * The predicate runs over the scan rather than over the page, because the sort is what it is
 * for. It reads properties off the node, so an already scan-bound strategy pays property
 * comparisons rather than the two existence checks a graph traversal needed.
 */
function ownershipTier(ownership: RecencyOwnership | undefined): readonly string[] {
  if (ownership === undefined) {
    return [];
  }
  return [
    `WITH n, ${ownOnlyDiscount('n')} AS own_only`,
    'ORDER BY CASE WHEN own_only THEN 1 ELSE 0 END,',
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
  const ownership = ownershipTier(input.ownership);
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
      ...(input.ownership === undefined
        ? {}
        : {
            ownSessionId: input.ownership.sessionId,
            ownSubstrateId: input.ownership.substrateId,
            ownAcknowledgedSequence: orderedPublicationSequence(
              input.ownership.acknowledgedSequence,
            ),
          }),
    },
    mapCandidate,
  );
}
