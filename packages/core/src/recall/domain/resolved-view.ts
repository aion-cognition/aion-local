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
   * Ids whose evidence this attempt could not read. A healthy stored fingerprint outlives a
   * transient outage: overwriting one with a degraded reading would suppress the memory on the
   * next recall as though the substrate had said it was unchanged.
   */
  readonly degraded: ReadonlySet<string>;
  /** Every issue the reading named, required and optional alike, for the coverage statement. */
  readonly issues: readonly EvidenceIssue[];
};

/** The empty view, for a caller assembling a pack with nothing read behind it. */
export const NO_EVIDENCE_VIEW: ResolvedEvidenceView = {
  provenance: new Map(),
  relatedClaims: new Map(),
  ownership: new Map(),
  degraded: new Set(),
  issues: [],
};

/** The verdict for one item. An id nothing answered about is unknown rather than either answer. */
export function ownershipOf(view: ResolvedEvidenceView, id: string): OwnershipVerdict {
  return view.ownership.get(id) ?? 'unknown';
}
