import { MAX_DERIVATION_ROOTS, type RelatedClaim } from '@aion/protocol';

import type { CheckedReadContext } from './coverage-checker.js';
import {
  claimProvenance,
  itemOrigins,
  type ProvenanceReading,
  type StageReadDeps,
} from './stage-reads.js';
import type { ItemMetadata } from '../../evidence/application/metadata.js';
import type { EvidenceResolver } from '../../evidence/application/resolver.js';
import { ownershipVerdict, type OwnershipVerdict } from '../../evidence/domain/ownership.js';
import { isCertifiedReading, type EvidenceResult } from '../../evidence/domain/result.js';
import type { ItemProvenance } from '../../infrastructure/graph/claim-provenance-queries.js';
import type { ItemOrigin } from '../../infrastructure/graph/origin-queries.js';
import type { ReadMode } from '../../infrastructure/graph/read-modes.js';
import type { ResolvedEvidenceView } from '../domain/resolved-view.js';

/**
 * The one reading behind a pack, and the two compositions it can come from: the certified
 * resolver, where an entry point has checked coverage and built a context, and the pack's own
 * late graph reads, where it has not. Both produce the same view, so every stage below reads one
 * shape whichever way the substrate answered.
 */

export type EvidenceReading =
  | {
      readonly kind: 'resolved';
      readonly results: ReadonlyMap<string, EvidenceResult<ItemMetadata>>;
      readonly issues: ResolvedEvidenceView['issues'];
    }
  | {
      readonly kind: 'stage';
      readonly provenance: ProvenanceReading;
      readonly origins: ReadonlyMap<string, ItemOrigin>;
    };

export type EvidenceReadInput = {
  readonly ids: readonly string[];
  readonly sessionId: string;
  readonly mode: ReadMode;
  /** Whether this read subtracts the asker's own record at all. */
  readonly attribute: boolean;
  /** Present once an entry point has checked coverage, which is what the resolver reads under. */
  readonly context?: CheckedReadContext;
};

export type EvidenceReadDeps = StageReadDeps & {
  /** The certified evidence surface. Absent leaves the pack on its own late reads. */
  readonly resolver?: EvidenceResolver;
};

/**
 * The reading itself: one batched round trip either way, over ids the run already holds. No
 * candidate's raw payload is opened, because a serving read that decoded an archive row per
 * candidate would turn a pack into a decode of the whole batch.
 */
export async function readEvidence(
  deps: EvidenceReadDeps,
  input: EvidenceReadInput,
): Promise<EvidenceReading> {
  const { resolver, ...stage } = deps;
  if (resolver !== undefined && input.context !== undefined) {
    const batch = await resolver.resolveMetadata(input.ids, input.context, {
      maxRoots: MAX_DERIVATION_ROOTS,
    });
    return { kind: 'resolved', results: batch.results, issues: batch.issues };
  }
  const [provenance, origins] = await Promise.all([
    claimProvenance(stage, input.ids, input.mode),
    input.attribute
      ? itemOrigins(stage, input.ids, input.sessionId, input.mode)
      : Promise.resolve<ReadonlyMap<string, ItemOrigin>>(new Map()),
  ]);
  return { kind: 'stage', provenance, origins };
}

/**
 * The graph predicate's own/other pair as a verdict. It names no session, so a node nothing
 * answered for stays unknown instead of becoming somebody's record by default.
 */
function verdictFromOrigin(origin: ItemOrigin | undefined): OwnershipVerdict {
  if (origin === undefined) {
    return 'unknown';
  }
  if (origin.other) {
    return 'shared';
  }
  return origin.own ? 'own_only' : 'unknown';
}

type Folded = {
  readonly provenance: Map<string, ItemProvenance>;
  readonly ownership: Map<string, OwnershipVerdict>;
  readonly degraded: Set<string>;
};

function foldResolved(
  results: ReadonlyMap<string, EvidenceResult<ItemMetadata>>,
  input: { readonly sessionId: string; readonly attribute: boolean },
): Folded {
  const provenance = new Map<string, ItemProvenance>();
  const ownership = new Map<string, OwnershipVerdict>();
  const degraded = new Set<string>();
  for (const result of results.values()) {
    if (result.address.kind !== 'id') {
      continue;
    }
    const { id } = result.address;
    // The one certainty question, asked in the resolver's own words. A reading whose inputs could
    // not be obtained may not overwrite healthy stored metadata and may not authorize a
    // subtraction, whether or not a provisional value came back with it.
    if (!isCertifiedReading(result)) {
      degraded.add(id);
    }
    if (result.value === undefined) {
      continue;
    }
    provenance.set(id, result.value.provenance);
    if (input.attribute) {
      ownership.set(id, ownershipVerdict(result.value.ownership, input.sessionId));
    }
  }
  return { provenance, ownership, degraded };
}

export type ResolvedViewInput = {
  readonly reading: EvidenceReading;
  readonly relatedClaims: ReadonlyMap<string, RelatedClaim>;
  readonly sessionId: string;
  readonly attribute: boolean;
};

/** The reading and the annotation as one view. Nothing is read here and nothing is decided. */
export function resolvedView(input: ResolvedViewInput): ResolvedEvidenceView {
  const { reading } = input;
  if (reading.kind === 'resolved') {
    const folded = foldResolved(reading.results, input);
    return {
      provenance: folded.provenance,
      relatedClaims: input.relatedClaims,
      ownership: folded.ownership,
      degraded: folded.degraded,
      issues: reading.issues,
    };
  }
  const ownership = new Map<string, OwnershipVerdict>();
  if (input.attribute) {
    for (const [id, origin] of reading.origins) {
      ownership.set(id, verdictFromOrigin(origin));
    }
  }
  return {
    provenance: reading.provenance.records,
    relatedClaims: input.relatedClaims,
    ownership,
    // A provenance read that failed says nothing about any candidate, so no stored fingerprint
    // may be rewritten from it and no subtraction may rest on it.
    degraded: reading.provenance.unavailable
      ? new Set(reading.provenance.requested)
      : new Set<string>(),
    issues: [],
  };
}
