import type { RelatedClaim } from '@aion/protocol';

import type { OwnershipVerdict } from '../../../evidence/domain/ownership.js';
import type { EvidenceIssue } from '../../../evidence/domain/result.js';
import type { ItemProvenance } from '../../../infrastructure/graph/claim-provenance-queries.js';
import type { ResolvedEvidenceView } from '../resolved-view.js';

/** One attempt's view, assembled by hand for the stages that read it. */
export function viewOf(
  parts: {
    readonly provenance?: ReadonlyMap<string, ItemProvenance>;
    readonly relatedClaims?: ReadonlyMap<string, RelatedClaim>;
    readonly ownership?: ReadonlyMap<string, OwnershipVerdict>;
    readonly degraded?: Iterable<string>;
    readonly issues?: readonly EvidenceIssue[];
  } = {},
): ResolvedEvidenceView {
  return {
    provenance: parts.provenance ?? new Map(),
    relatedClaims: parts.relatedClaims ?? new Map(),
    ownership: parts.ownership ?? new Map(),
    degraded: new Set(parts.degraded ?? []),
    issues: parts.issues ?? [],
  };
}
