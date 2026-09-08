import type {
  CoverageGap,
  CoverageGapReason,
  CoverageLimitation,
  CoverageRefusal,
  HistoryCoverage,
} from '@aion/protocol';

/**
 * The coverage statement in prose, for the surfaces a person or a model reads.
 *
 * One renderer, because text and JSON have to say the same thing: a present value shown under
 * a historical label, or a limitation carried in JSON and dropped from the text, is how a
 * caller comes to believe an answer covers more than it does. Every line here names the
 * machine word the JSON carries, so the two cannot drift apart quietly.
 */

const LIMITATION_TEXT: Readonly<Record<CoverageLimitation, string>> = {
  coverage_contract_not_active:
    'the coverage record is preparing, so retained history is not certified',
  gap_list_truncated: 'the gap list is cut at its limit, so more fields are missing than listed',
};

const GAP_TEXT: Readonly<Record<CoverageGapReason, string>> = {
  not_recorded: 'was never recorded',
  unversioned_legacy: 'has no version history to read',
  erased_interval: 'has an erased interval over the requested moment',
  outside_field_policy: 'is outside what the field policy preserves',
  unresolved_mapping: 'has an unknown mapping, which is not proof the source is missing',
  store_unavailable: 'could not be read from its store',
  pending_publication: 'is waiting on a publication that has not been acknowledged',
  unverified_scope: 'has no census or version proof, so its scope is unverified',
  unresolved_reference: 'names a reference whose target is unresolved',
  bounded_read: 'needed a traversal that stopped on its bound',
  required_scope_missing: 'is required and its scope is missing',
};

function gapLine(gap: CoverageGap): string {
  const subject = gap.id === undefined ? gap.field : `${gap.field} for ${gap.id}`;
  return `gap: ${subject} ${GAP_TEXT[gap.reason]} (${gap.reason}).`;
}

export function coverageLines(coverage: HistoryCoverage): readonly string[] {
  const asked = [
    ...(coverage.as_of === undefined ? [] : [`as_of ${coverage.as_of}`]),
    ...(coverage.knew_at === undefined ? [] : [`knew_at ${coverage.knew_at}`]),
  ];
  const since =
    coverage.history_since === undefined
      ? 'no coverage boundary yet'
      : `covered since ${coverage.history_since}`;
  return [
    `history: ${coverage.status}, ${since}${asked.length === 0 ? '' : `, asked ${asked.join(' and ')}`}.`,
    ...coverage.limitations.map(
      (limitation) => `limitation: ${LIMITATION_TEXT[limitation]} (${limitation}).`,
    ),
    ...coverage.gaps.map(gapLine),
  ];
}

function refusalText(refusal: CoverageRefusal): string {
  const { requested, bounds } = refusal;
  switch (refusal.reason) {
    case 'before_horizon':
      return `knew_at ${requested.knew_at ?? 'the requested moment'} is before the coverage boundary ${bounds.history_since ?? 'the substrate holds'}`;
    case 'future_knowledge':
      return `knew_at ${requested.knew_at ?? 'the requested moment'} is after the request clock ${requested.now}, and knowledge nobody has yet cannot be read`;
    case 'coverage_store_unavailable':
      return 'the coverage record could not be read, so no answer can say what it covers';
    case 'coverage_changed':
      return 'the coverage record changed while this read was in flight, so its answer would describe a contract that no longer holds';
  }
}

export function refusalLines(refusal: CoverageRefusal): readonly string[] {
  return [`refused: ${refusalText(refusal)} (${refusal.reason}).`];
}
