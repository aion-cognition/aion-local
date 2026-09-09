import type { RelatedClaim } from '@aion/protocol';

import type { OwnershipVerdict } from '../../evidence/domain/ownership.js';
import type { EvidenceIssue } from '../../evidence/domain/result.js';
import type { ItemProvenance } from '../../infrastructure/graph/claim-provenance-queries.js';

/**
 * One reading of what the substrate says about a pack's candidates, built once per attempt.
 *
 * Suppression, the near-duplicate fold, rendering and the holdings record all read this. Before
 * it existed each of them asked its own question, so a pack could withhold a memory on one
 * reading and record a fingerprint from another taken microseconds later. Nothing here is
 * fetched and nothing here is decided: the view is what the attempt saw, and the stages decide
 * from it.
 *
 * Ownership arrives as a verdict for the asking session rather than as a stored boolean about
 * "somebody else", because the stored summary answers for every future asker and only a request
 * knows who is asking.
 */
export type ResolvedEvidenceView = {
  readonly provenance: ReadonlyMap<string, ItemProvenance>;
  readonly relatedClaims: ReadonlyMap<string, RelatedClaim>;
  /** Absent for an id nothing answered about, which reads as unknown ownership. */
  readonly ownership: ReadonlyMap<string, OwnershipVerdict>;
  /**
   * Ids whose semantic inputs this attempt could not obtain or certify: a store it could not
   * reach, a publication position that moved under it, an allowance that ran out, or no value at
   * all. One set for every consumer, because suppression, folding and the stored fingerprint must
   * not disagree about which readings are safe to act on.
   *
   * A settled observation is not in it. An ancestry the walk reported short is what the substrate
   * holds, so it fingerprints and folds like any other answer.
   */
  readonly degraded: ReadonlySet<string>;
  /** Every issue the reading named, required and optional alike, for the coverage statement. */
  readonly issues: readonly EvidenceIssue[];
};

/**
 * The verdict for one item. An id nothing answered about is unknown rather than either answer,
 * and so is one whose reading this attempt could not certify: an uncertified own-only value is
 * exactly the reading that must not withhold a memory.
 */
export function ownershipOf(view: ResolvedEvidenceView, id: string): OwnershipVerdict {
  if (view.degraded.has(id)) {
    return 'unknown';
  }
  return view.ownership.get(id) ?? 'unknown';
}

/** Whether a stage may act on this item's semantic reading at all. */
export function certifiedIn(view: ResolvedEvidenceView, id: string): boolean {
  return !view.degraded.has(id);
}

/**
 * The same reading with nothing in it certified.
 *
 * A read that finishes under a position the substrate will not honour has readings nobody stands
 * behind, whatever the reading itself said while the position looked good. The values are kept —
 * they are what the attempt saw, and the answer still renders from them — but no stage may
 * withhold, fold or fingerprint on them, which is what the degraded set says.
 */
export function uncertifiedThroughout(
  view: ResolvedEvidenceView,
  ids: Iterable<string>,
): ResolvedEvidenceView {
  return { ...view, degraded: new Set([...view.degraded, ...ids]) };
}
