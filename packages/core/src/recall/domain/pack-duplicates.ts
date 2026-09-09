import type { RelatedClaim } from '@aion/protocol';

import type { FusedItem } from './fusion.js';
import { certifiedIn, type ResolvedEvidenceView } from './resolved-view.js';
import { standingFor } from './standing.js';
import type { ItemProvenance } from '../../infrastructure/graph/claim-provenance-queries.js';
import type { RestatedClaimPair } from '../../infrastructure/graph/near-duplicate-queries.js';

/**
 * Which candidates may stand in for which, so a pack that would print one claim twice prints it
 * once. This decides eligibility only; whether anything is actually withheld is `pack.ts`'s,
 * because only assembly knows what it served.
 *
 * The subtraction is a pack decision and nothing more. No record is merged, no lineage is closed,
 * the ranked set and the admission report are unchanged, both retrieved ids stay in the usage
 * stream's telemetry, and the next recall decides again from scratch. Exposure follows the pack,
 * so only the record a reader was actually handed is charged one. `claim_dedup` in maintenance
 * remains the only thing that merges a claim, behind a two-pass judge this path deliberately
 * does not have.
 *
 * This is also the only place two different node ids are read as one claim. Fusion merges by id
 * and carries the rest through, so a decision that needs standing, subject identity or a stated
 * correction is made here, once, with the provenance read in front of it.
 *
 * Because it has no judge it withholds only where the substrate's own structure says the two
 * are one sentence: the nomination query pairs claims on a matching subject key and a matching
 * stored text fold, and the gates below add the reasons a reader still needs both. Standing and
 * currency have to agree, so a quotation is never folded into an inference and a superseded
 * claim never into a current one. Anything a correction touches stays served, because
 * disagreeing is the reason to read the second one. And nothing is folded on absent or
 * uncertified evidence: a lookup that did not answer for both sides, or a reading whose inputs
 * the attempt could not obtain, withholds nothing at all.
 */

export type FoldableClaimsInput = {
  readonly items: readonly FusedItem[];
  /** Same key, same fold, no recorded disagreement (`near-duplicate-queries.ts`). */
  readonly pairs: readonly RestatedClaimPair[];
  /**
   * The attempt's one reading. An id with no provenance entry is one this run could not
   * establish standing for, so it is left alone: a successful read answers for every candidate
   * it was asked about, and folding on absent evidence prints the weaker of two statements as
   * though it were the stronger.
   */
  readonly view: ResolvedEvidenceView;
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
    // Nothing is folded on a reading the attempt could not certify. A provisional record that
    // came back beside an unreachable store cannot say the two are the same sentence, and the
    // one this pack withheld is the one nobody reads.
    if (!certifiedIn(input.view, left.id) || !certifiedIn(input.view, right.id)) {
      continue;
    }
    if (contested(left, input.view.provenance, input.view.relatedClaims)) {
      continue;
    }
    if (contested(right, input.view.provenance, input.view.relatedClaims)) {
      continue;
    }
    if (!comparable(left, right, input.view.provenance)) {
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
