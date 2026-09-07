import type { RelatedClaim } from '@aion/protocol';

import type { FusedItem } from './fusion.js';
import { standingFor } from './standing.js';
import type { ItemProvenance } from '../../infrastructure/graph/claim-provenance-queries.js';
import type { RestatedClaimPair } from '../../infrastructure/graph/near-duplicate-queries.js';

/**
 * Which candidates may stand in for which, so a pack that would print one claim twice prints it
 * once. This decides eligibility only; whether anything is actually withheld is `pack.ts`'s,
 * because only assembly knows what it served.
 *
 * The subtraction is a pack decision and nothing more. No record is merged, no lineage is
 * closed, the admitted set that reaches reinforcement and access tracking is unchanged, and the
 * next recall decides again from scratch. `claim_dedup` in maintenance remains the only thing
 * that merges a claim, behind a two-pass judge this path deliberately does not have.
 *
 * Because it has no judge it withholds only where the substrate's own structure says the two
 * are one sentence: the nomination query pairs claims on a matching subject key and a matching
 * stored text fold, and the gates below add the reasons a reader still needs both. Standing and
 * currency have to agree, so a quotation is never folded into an inference and a superseded
 * claim never into a current one. Anything a correction touches stays served, because
 * disagreeing is the reason to read the second one. And nothing is folded on absent evidence:
 * a provenance lookup that did not answer for both sides withholds nothing at all.
 */

export type FoldableClaimsInput = {
  readonly items: readonly FusedItem[];
  /** Same key, same fold, no recorded disagreement (`near-duplicate-queries.ts`). */
  readonly pairs: readonly RestatedClaimPair[];
  /**
   * Standing and stated corrections, by node id. The read fails soft to an empty map, and an id
   * with no entry is one this run could not establish either for, so it is left alone: a
   * successful read answers for every candidate it was asked about.
   */
  readonly provenance: ReadonlyMap<string, ItemProvenance>;
  /** The current claim in a raw turn's family, keyed as the pack annotates it. */
  readonly relatedClaims: ReadonlyMap<string, RelatedClaim>;
};

/**
 * Whether the substrate has said something further about the item. Each of the three makes its
 * text news rather than a repeat, and each is a reason to print it beside whatever it restates.
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
 * same point in the lineage. A recorded utterance and a model's reading of it can carry one
 * sentence with different weight behind them, and folding one into the other prints the weaker
 * as though it were the stronger.
 */
function comparable(
  left: FusedItem,
  right: FusedItem,
  provenance: ReadonlyMap<string, ItemProvenance>,
): boolean {
  const leftRecord = provenance.get(left.id);
  const rightRecord = provenance.get(right.id);
  if (leftRecord === undefined || rightRecord === undefined) {
    return false;
  }
  if (left.currency !== right.currency) {
    return false;
  }
  const leftStanding = standingFor(left, leftRecord);
  const rightStanding = standingFor(right, rightRecord);
  return (
    leftStanding.kind === rightStanding.kind &&
    leftStanding.attribution === rightStanding.attribution
  );
}

/**
 * For each candidate, the candidates it may be withheld in favour of. Symmetric on purpose:
 * assembly walks its own serving order and folds whichever member it reaches second, so the map
 * carries no preference of its own about which of a pair a reader should get.
 */
export function foldableClaims(
  input: FoldableClaimsInput,
): ReadonlyMap<string, ReadonlySet<string>> {
  const foldable = new Map<string, Set<string>>();
  if (input.pairs.length === 0) {
    return foldable;
  }

  const byId = new Map(input.items.map((item) => [item.id, item]));
  for (const pair of input.pairs) {
    const left = byId.get(pair.left);
    const right = byId.get(pair.right);
    if (left === undefined || right === undefined) {
      continue;
    }
    if (contested(left, input.provenance, input.relatedClaims)) {
      continue;
    }
    if (contested(right, input.provenance, input.relatedClaims)) {
      continue;
    }
    if (!comparable(left, right, input.provenance)) {
      continue;
    }
    for (const [id, other] of [
      [left.id, right.id],
      [right.id, left.id],
    ] as const) {
      const held = foldable.get(id) ?? new Set<string>();
      held.add(other);
      foldable.set(id, held);
    }
  }

  return foldable;
}
