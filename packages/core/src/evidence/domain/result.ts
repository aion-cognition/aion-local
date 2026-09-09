import type { CoverageField, HistoryGapReason } from '@aion/protocol';

import type { EvidenceAddress } from './address.js';
import type { EvidenceRevision } from '../../infrastructure/publication/preconditions.js';

/**
 * What one answer about a source says, in three separable dimensions.
 *
 * Residency is where the storage sits, evidence is whether the fields this request needed were
 * established, and coverage is whether the substrate promises to answer for the moment asked
 * about. They are separate because they fail separately: an evicted source can carry complete
 * evidence, a resident one can be missing a scope proof, and neither says anything about the
 * horizon. Collapsing them is how a thin answer passes for a whole one.
 */

export type EvidenceUse =
  | 'serving_metadata'
  | 'raw_inspection'
  | 'search_indexing'
  | 'narrative_member'
  | 'claim_judgment'
  | 'entity_judgment';

/**
 * The purposes a caller may ask for by name. `search_indexing` is missing on purpose: indexing
 * reads parts without applying disclosure-time suppression, which is projection maintenance
 * rather than something a request may select. Every public path still suppresses before it
 * discloses.
 */
export const SELECTABLE_EVIDENCE_USES = [
  'serving_metadata',
  'raw_inspection',
  'narrative_member',
  'claim_judgment',
  'entity_judgment',
] as const satisfies readonly EvidenceUse[];

export function isSelectableUse(value: string): value is (typeof SELECTABLE_EVIDENCE_USES)[number] {
  return (SELECTABLE_EVIDENCE_USES as readonly string[]).includes(value);
}

/** The uses that end in a destructive write, which need complete evidence and supported coverage. */
export function isDestructiveUse(use: EvidenceUse): boolean {
  return use === 'claim_judgment' || use === 'entity_judgment';
}

/**
 * `unknown-mapping` is a fourth state rather than a guess at one of the first three: a source
 * whose records nobody can account for is not evidence that its projection is gone.
 */
export type EvidenceResidency = 'resident' | 'retiring' | 'evicted' | 'unknown-mapping';

/** The closed field set the transport names gaps against, shared with the coverage statement. */
export type EvidenceField = CoverageField;

export type EvidenceIssue = {
  readonly address: EvidenceAddress;
  readonly field: EvidenceField;
  /** Whether this request needed the field. A required gap is what makes a result partial. */
  readonly required: boolean;
} & (
  | {
      readonly reason: 'unsupported_history';
      /** Proved from the record that should have held the value, never inferred. */
      readonly historyReason: HistoryGapReason;
    }
  | {
      readonly reason:
        | 'unresolved_mapping'
        | 'store_unavailable'
        | 'pending_publication'
        | 'unverified_scope'
        | 'unresolved_reference'
        | 'suppressed_source'
        | 'cycle'
        | 'depth_limit'
        | 'budget_limit'
        | 'required_scope_missing'
        | 'not_found';
    }
);

export type EvidenceState =
  | { readonly status: 'complete-for-use' }
  | { readonly status: 'incomplete'; readonly reasons: readonly EvidenceIssue[] }
  | { readonly status: 'unavailable-retryable'; readonly reasons: readonly EvidenceIssue[] }
  | { readonly status: 'not-found-in-coverage'; readonly reasons: readonly EvidenceIssue[] };

export type EvidenceCoverage =
  | { readonly status: 'supported' }
  | { readonly status: 'unavailable'; readonly gaps: readonly EvidenceIssue[] };

export type EvidenceResult<T> = {
  readonly address: EvidenceAddress;
  readonly residency: EvidenceResidency;
  readonly evidence: EvidenceState;
  readonly coverage: EvidenceCoverage;
  /**
   * Independently verified fields, which an incomplete result may still carry. Its presence is
   * not permission to use the result: a destructive consumer reads the state, never the value.
   */
  readonly value?: T;
  /** The dependency set this result was read under, for a writer that fences on it later. */
  readonly revision?: EvidenceRevision;
};

const RETRYABLE_REASONS = new Set(['store_unavailable', 'pending_publication']);

/**
 * Reasons that say the request could not obtain or certify the field, rather than reporting what
 * the substrate holds. A bounded walk, a proved absence and a loop are answers a reader may act
 * on; a store it could not reach, a position that moved under it and an exhausted allowance are
 * not, because none of them says what the value is now.
 */
const UNCERTIFIED_REASONS = new Set(['store_unavailable', 'pending_publication', 'budget_limit']);

/**
 * Whether this issue says the reading's inputs could not be obtained.
 *
 * Requiredness answers a different question. It says what this request needed, which decides
 * whether the result is complete for its use and whether the gap makes the statement partial. An
 * exhausted allowance says the read did not finish whatever the caller needed from it, so an
 * optional field's gap is still no licence to store a value derived from it.
 */
export function isUncertifiedIssue(issue: EvidenceIssue): boolean {
  return UNCERTIFIED_REASONS.has(issue.reason);
}

/**
 * Whether a consumer may treat this result's value as the substrate's current answer.
 *
 * The one certainty question every serving consumer asks, so suppression, folding and the stored
 * fingerprint cannot disagree about which readings are safe to act on. A settled observation of
 * incomplete ancestry is certified and carries its own gap; a reading whose inputs could not be
 * obtained is not, whether or not a provisional value came back with it.
 *
 * A complete-for-use state carries no issue list, so an optional gap on such a result is named on
 * the batch instead. A caller holding both asks this and reads that list; neither alone is the
 * whole answer.
 */
export function isCertifiedReading(result: EvidenceResult<unknown>): boolean {
  if (result.value === undefined) {
    return false;
  }
  if (result.evidence.status === 'complete-for-use') {
    return true;
  }
  return !result.evidence.reasons.some(isUncertifiedIssue);
}

/** A required-field issue, which is the only kind that decides the evidence value. */
export function isRequiredIssue(issue: EvidenceIssue): boolean {
  return issue.required || issue.reason === 'required_scope_missing';
}

/**
 * Which of the four evidence values a set of issues produces.
 *
 * Completeness is about the fields this request needed, so an optional gap leaves the result
 * complete for its use and is still named. Among the required ones, a store that could not be
 * read outranks everything: retrying is the repair, and calling it incomplete would invite a
 * caller to treat a transient outage as a settled answer. Proved absence and proved suppression
 * are the substrate answering, so they are not-found rather than a gap.
 */
export function classifyEvidence(issues: readonly EvidenceIssue[]): EvidenceState {
  const required = issues.filter(isRequiredIssue);
  if (required.length === 0) {
    return { status: 'complete-for-use' };
  }
  if (required.some((issue) => RETRYABLE_REASONS.has(issue.reason))) {
    return { status: 'unavailable-retryable', reasons: issues };
  }
  if (
    required.every((issue) => issue.reason === 'not_found' || issue.reason === 'suppressed_source')
  ) {
    return { status: 'not-found-in-coverage', reasons: issues };
  }
  return { status: 'incomplete', reasons: issues };
}

/**
 * Coverage stands unless a required field could not be established. Proved suppression and
 * certified absence are answers the substrate makes, so neither one lowers what it says it
 * covers.
 */
export function classifyCoverage(issues: readonly EvidenceIssue[]): EvidenceCoverage {
  const gaps = issues.filter(
    (issue) =>
      isRequiredIssue(issue) &&
      issue.reason !== 'not_found' &&
      issue.reason !== 'suppressed_source',
  );
  return gaps.length === 0 ? { status: 'supported' } : { status: 'unavailable', gaps };
}

export type EvidenceResultInput<T> = {
  readonly address: EvidenceAddress;
  readonly residency: EvidenceResidency;
  readonly issues: readonly EvidenceIssue[];
  readonly value?: T;
  readonly revision?: EvidenceRevision;
};

/** One result, with its state and coverage derived from the same issue set. */
export function evidenceResult<T>(input: EvidenceResultInput<T>): EvidenceResult<T> {
  return {
    address: input.address,
    residency: input.residency,
    evidence: classifyEvidence(input.issues),
    coverage: classifyCoverage(input.issues),
    ...(input.value === undefined ? {} : { value: input.value }),
    ...(input.revision === undefined ? {} : { revision: input.revision }),
  };
}

/** Whether a destructive consumer may act on this result. Presence of a value never answers it. */
export function isUsableForWrite(result: EvidenceResult<unknown>): boolean {
  return result.evidence.status === 'complete-for-use' && result.coverage.status === 'supported';
}
