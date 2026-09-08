import type { CoverageField, CoverageGap, HistoryCoverage, HistoryGapReason } from '@aion/protocol';

import { sourcePartAddress } from '../../infrastructure/sqlite/source-identity.js';

/**
 * Why the evidence behind one field is not complete, in the resolver's own words. Closed, and
 * separate from the transport vocabulary below: the resolver decides adequacy, this module
 * decides how each verdict is said to a caller, and neither one guesses the other's half.
 */
export const EVIDENCE_ISSUE_REASONS = [
  'unresolved_mapping',
  'store_unavailable',
  'pending_publication',
  'unverified_scope',
  'unresolved_reference',
  'unsupported_history',
  'cycle',
  'depth_limit',
  'budget_limit',
  'suppressed_source',
  'required_scope_missing',
  'not_found',
] as const;

export type EvidenceIssueReason = (typeof EVIDENCE_ISSUE_REASONS)[number];

export type EvidenceIssue = {
  readonly reason: EvidenceIssueReason;
  readonly field: CoverageField;
  /** The resolved node or source id, or a part address built by `coverageGapId`. */
  readonly id?: string;
  /**
   * The proved cause behind a missing historical value. Required by `unsupported_history` and
   * meaningless anywhere else: the transport never invents a reason history is absent.
   */
  readonly historyReason?: HistoryGapReason;
  /** Whether the answer needed this field. A required gap is what makes a result partial. */
  readonly required: boolean;
};

/**
 * How one issue reaches a caller. A gap names a field the answer could not establish. A
 * result-level outcome is not a gap: proved suppression is supported non-disclosure, and
 * certified absence is a supported no-match. Reporting either as a gap would turn an answer
 * the substrate stands behind into a partial one.
 */
export type EvidenceTreatment =
  | { readonly kind: 'gap'; readonly gap: CoverageGap }
  | { readonly kind: 'result'; readonly outcome: 'suppressed_source' | 'not_found' };

export type EvidenceOutcome = {
  readonly outcome: 'suppressed_source' | 'not_found';
  readonly field: CoverageField;
  readonly id?: string;
};

/**
 * The bound on the enumerated gap list. A list that grows with the substrate stops being
 * readable and starts being a second answer, so it is cut and the cut is disclosed.
 */
export const COVERAGE_GAP_LIMIT = 32;

function gap(issue: EvidenceIssue, reason: CoverageGap['reason']): EvidenceTreatment {
  return {
    kind: 'gap',
    gap: {
      ...(issue.id === undefined ? {} : { id: issue.id }),
      field: issue.field,
      reason,
    },
  };
}

/**
 * One issue's transport treatment.
 *
 * An unknown mapping is not a verified missing source, a missing census or version proof is
 * not a store outage, and a traversal that ran out of budget is not evidence that nothing is
 * there. Each of those repairs differently, so each keeps its own word.
 */
export function evidenceTreatment(issue: EvidenceIssue): EvidenceTreatment {
  switch (issue.reason) {
    case 'unresolved_mapping':
      return gap(issue, 'unresolved_mapping');
    case 'store_unavailable':
      return gap(issue, 'store_unavailable');
    case 'pending_publication':
      return gap(issue, 'pending_publication');
    case 'unverified_scope':
      return gap(issue, 'unverified_scope');
    case 'unresolved_reference':
      return gap(issue, 'unresolved_reference');
    case 'unsupported_history': {
      if (issue.historyReason === undefined) {
        throw new Error('unsupported_history needs the proved cause its record carries');
      }
      return gap(issue, issue.historyReason);
    }
    // Which termination happened stays in the resolver's diagnostics. To a caller they are one
    // thing: the traversal the answer needed did not finish.
    case 'cycle':
    case 'depth_limit':
    case 'budget_limit':
      return gap(issue, 'bounded_read');
    case 'required_scope_missing':
      return gap(issue, 'required_scope_missing');
    case 'suppressed_source':
      return { kind: 'result', outcome: 'suppressed_source' };
    case 'not_found':
      return { kind: 'result', outcome: 'not_found' };
  }
}

export type CoverageEvidence = {
  readonly coverage: HistoryCoverage;
  readonly outcomes: readonly EvidenceOutcome[];
};

/**
 * Folds a run's issues into the statement the answer carries.
 *
 * A required-field gap makes the result partial; suppression and certified absence on their
 * own do not. Truncation is itself a partial answer: a caller told the list was cut cannot
 * treat what it holds as the whole of what is missing. Nothing here upgrades a partial
 * statement back to supported.
 */
export function applyEvidence(
  base: HistoryCoverage,
  issues: readonly EvidenceIssue[],
): CoverageEvidence {
  const gaps = [...base.gaps];
  const outcomes: EvidenceOutcome[] = [];
  const limitations = [...base.limitations];
  let partial = base.status === 'partial';
  let truncated = false;
  for (const issue of issues) {
    const treatment = evidenceTreatment(issue);
    if (treatment.kind === 'result') {
      outcomes.push({
        outcome: treatment.outcome,
        field: issue.field,
        ...(issue.id === undefined ? {} : { id: issue.id }),
      });
      continue;
    }
    // A missing required scope carries its own requiredness: a partial empty answer that reached
    // a caller as supported would read as a no-match the substrate stands behind.
    partial = partial || issue.required || issue.reason === 'required_scope_missing';
    if (gaps.length < COVERAGE_GAP_LIMIT) {
      gaps.push(treatment.gap);
    } else {
      truncated = true;
    }
  }
  if (truncated && !limitations.includes('gap_list_truncated')) {
    limitations.push('gap_list_truncated');
  }
  return {
    coverage: {
      ...base,
      status: partial || truncated ? 'partial' : base.status,
      limitations,
      gaps,
    },
    outcomes,
  };
}

/**
 * What a gap points at: a node or source by its own id, or one part of a source. Two parts of
 * one source are two addresses, so a gap in one never reads as a gap in the other.
 */
export type GapTarget =
  | { readonly kind: 'node'; readonly id: string }
  | {
      readonly kind: 'part';
      readonly sourceId: string;
      readonly partKind: string;
      readonly ordinal: number;
    };

export function coverageGapId(target: GapTarget): string {
  return target.kind === 'node'
    ? target.id
    : sourcePartAddress(target.sourceId, target.partKind, target.ordinal);
}

/**
 * The reverse conversion, validated by re-encoding: an address that does not encode back to
 * itself is not one this substrate produced, and reading it as a part would name a record
 * nobody addressed that way.
 */
export function decodeCoverageGapId(id: string): GapTarget {
  const [prefix, sourceId, partKind, ordinal] = id.split(':');
  if (prefix !== 'part' || sourceId === undefined || partKind === undefined) {
    return { kind: 'node', id };
  }
  const position = Number(ordinal);
  if (!Number.isInteger(position) || sourcePartAddress(sourceId, partKind, position) !== id) {
    return { kind: 'node', id };
  }
  return { kind: 'part', sourceId, partKind, ordinal: position };
}
