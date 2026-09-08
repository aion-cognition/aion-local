import type { HistoryCoverage } from '@aion/protocol';

import {
  applyEvidence,
  coverageGapId,
  decodeCoverageGapId,
  type CoverageEvidence,
  type EvidenceIssue as CoverageEvidenceIssue,
  type GapTarget,
} from '../../recall/application/coverage-reasons.js';
import {
  idAddress,
  partAddress,
  type EvidenceAddress,
  type SourcePartKind,
} from '../domain/address.js';
import type { EvidenceIssue } from '../domain/result.js';

/**
 * The one crossing between what the resolver decided and how a caller is told.
 *
 * The resolver owns adequacy and the reason for it; the coverage adapter owns the words. This
 * module converts between the two and does nothing else, so neither side ever guesses the
 * other's half, and the address conversion runs through the single validated encoder rather
 * than a second spelling of the same string.
 */

export function gapTargetFor(address: EvidenceAddress): GapTarget {
  return address.kind === 'id'
    ? { kind: 'node', id: address.id }
    : {
        kind: 'part',
        sourceId: address.sourceId,
        partKind: address.partKind,
        ordinal: address.ordinal,
      };
}

/** The transport id for an address: a node or source id, or the canonical part address. */
export function evidenceGapId(address: EvidenceAddress): string {
  return coverageGapId(gapTargetFor(address));
}

/** The reverse, through the same validated conversion, so the round trip has one implementation. */
export function addressForGapId(id: string): EvidenceAddress {
  const target = decodeCoverageGapId(id);
  return target.kind === 'node'
    ? idAddress(target.id)
    : partAddress(target.sourceId, target.partKind as SourcePartKind, target.ordinal);
}

export function coverageIssueFor(issue: EvidenceIssue): CoverageEvidenceIssue {
  return {
    reason: issue.reason,
    field: issue.field,
    id: evidenceGapId(issue.address),
    required: issue.required,
    ...(issue.reason === 'unsupported_history' ? { historyReason: issue.historyReason } : {}),
  };
}

/** Folds a run's issues into the coverage statement its answer carries. */
export function statedCoverage(
  base: HistoryCoverage,
  issues: readonly EvidenceIssue[],
): CoverageEvidence {
  return applyEvidence(base, issues.map(coverageIssueFor));
}
