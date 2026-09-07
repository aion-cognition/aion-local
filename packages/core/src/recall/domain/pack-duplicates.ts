import type { RelatedClaim } from '@aion/protocol';

import type { FusedItem } from './fusion.js';
import { standingFor } from './standing.js';
import type { ItemProvenance } from '../../infrastructure/graph/claim-provenance-queries.js';
import type { ClaimSimilarity } from '../../infrastructure/graph/near-duplicate-queries.js';

/**
 * The third serving-layer subtraction: one assertion the substrate holds twice is printed once.
 *
 * It is a pack decision and nothing more. No record is merged, no lineage is closed, and the
 * admitted set that reaches reinforcement, access tracking and the method counters is the set
 * it has always been. The next recall in the next session makes the decision again from
 * scratch, and `claim_dedup` in maintenance remains the only thing that merges a claim, behind
 * a two-pass judge this path deliberately does not have.
 *
 * Because it has no judge, it fires only where the substrate's own structure and its own
 * measurement agree. Three gates, all of them structural except the last:
 *
 * a matching claim key, so the two assert the same attribute of the same entity; compatible
 * standing and currency, so a quotation is never folded into an inference and a superseded
 * claim never into a current one; and a cosine above a floor sitting over the whole measured
 * band of claims about one subject that are not one assertion. Anything a corrective
 * relationship touches is out: a claim somebody stated is wrong, a claim with a successor, and
 * a claim the substrate has since answered differently all stay served, because the reason to
 * read the second one is exactly that it disagrees with the first.
 */

export type NearDuplicateInput = {
  /** In serving order, best first: the first member of a group is the one the pack keeps. */
  readonly items: readonly FusedItem[];
  /** Same-key pairs and the cosine between them, from `near-duplicate-queries.ts`. */
  readonly similarities: readonly ClaimSimilarity[];
  /** `AION_PACK_DUPLICATE_COSINE_FLOOR`: the cosine a pair clears to be one assertion. */
  readonly floor: number;
  /** Standing and stated corrections, by node id. An item with no entry carries neither. */
  readonly provenance: ReadonlyMap<string, ItemProvenance>;
  /** The current claim in a raw turn's family, keyed as the pack annotates it. */
  readonly relatedClaims: ReadonlyMap<string, RelatedClaim>;
};

/**
 * Whether the item is one the substrate has said something further about. Each of the three
 * makes the item's own text news rather than a repeat, and each is a reason to print it beside
 * whatever it is a near-duplicate of.
 */
function contested(
  item: FusedItem,
  provenance: ReadonlyMap<string, ItemProvenance>,
  relatedClaims: ReadonlyMap<string, RelatedClaim>,
): boolean {
  return (
    item.supersededBy !== undefined ||
    relatedClaims.has(item.id) ||
    provenance.get(item.id)?.claimedCorrection !== undefined
  );
}

/**
 * Whether the two are the same kind of statement, told with the same authority, standing at the
 * same point in the lineage. A recorded utterance and a model's reading of it say the same words
 * with different weight behind them, and folding one into the other prints the weaker as though
 * it were the stronger.
 */
function comparable(
  left: FusedItem,
  right: FusedItem,
  provenance: NearDuplicateInput['provenance'],
): boolean {
  if (left.currency !== right.currency) {
    return false;
  }
  const leftStanding = standingFor(left, provenance.get(left.id));
  const rightStanding = standingFor(right, provenance.get(right.id));
  return (
    leftStanding.kind === rightStanding.kind &&
    leftStanding.attribution === rightStanding.attribution
  );
}

/**
 * The ids to leave out of the pack. Items arrive best first, so the member of a group this walk
 * reaches first is the one the reader gets, and every later member measured against it is a
 * second copy of an answer already in front of them.
 *
 * A pair is compared against the item actually kept rather than against every earlier item, so
 * suppression never chains: an item held back cannot itself hold anything back.
 */
export function suppressedNearDuplicates(input: NearDuplicateInput): ReadonlySet<string> {
  const suppressed = new Set<string>();
  if (input.similarities.length === 0) {
    return suppressed;
  }

  const above = new Map<string, Set<string>>();
  for (const pair of input.similarities) {
    if (pair.similarity < input.floor) {
      continue;
    }
    for (const [id, other] of [
      [pair.left, pair.right],
      [pair.right, pair.left],
    ] as const) {
      const held = above.get(id) ?? new Set<string>();
      held.add(other);
      above.set(id, held);
    }
  }

  const kept: FusedItem[] = [];
  for (const item of input.items) {
    const neighbours = above.get(item.id);
    if (neighbours === undefined || contested(item, input.provenance, input.relatedClaims)) {
      kept.push(item);
      continue;
    }
    const twin = kept.find(
      (earlier) =>
        neighbours.has(earlier.id) &&
        !contested(earlier, input.provenance, input.relatedClaims) &&
        comparable(earlier, item, input.provenance),
    );
    if (twin === undefined) {
      kept.push(item);
      continue;
    }
    suppressed.add(item.id);
  }

  return suppressed;
}
