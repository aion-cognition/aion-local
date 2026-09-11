import type { CheckedReadContext } from './coverage-checker.js';
import { revalidateNarrativeRepresentations } from '../../evidence/application/narrative-representation.js';
import { idAddress } from '../../evidence/domain/address.js';
import type { EvidenceIssue } from '../../evidence/domain/result.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import type { FusedItem } from '../domain/fusion.js';
import type { ResolvedEvidenceView } from '../domain/resolved-view.js';

/** Unproved representation choices are withheld even when ordinary semantic fields may degrade. */
export function discloseFamilyGaps(
  view: ResolvedEvidenceView,
  candidates: readonly FusedItem[],
): ResolvedEvidenceView {
  if (view.narrativeFamilies === undefined) {
    return view;
  }
  const gaps: EvidenceIssue[] = [];
  for (const candidate of candidates) {
    if (!candidate.labels.includes('Narrative')) {
      continue;
    }
    const value = view.narrativeFamilies.values.get(candidate.id);
    if (value?.selection === 'not_selected') {
      continue;
    }
    const field =
      value === undefined || value.selection === 'unknown'
        ? 'representation_preference'
        : 'narrative_revision';
    const missing =
      value === undefined || value.selection === 'unknown' || value.publication === 'unknown';
    if (
      missing &&
      !view.issues.some(
        (issue) =>
          issue.address.kind === 'id' &&
          issue.address.id === candidate.id &&
          issue.field === field &&
          issue.required,
      )
    ) {
      gaps.push({
        address: idAddress(candidate.id),
        field,
        reason: 'unverified_scope',
        required: true,
      });
    }
  }
  if (gaps.length === 0) {
    return view;
  }
  const values = new Map(view.narrativeFamilies.values);
  for (const gap of gaps) {
    if (gap.address.kind !== 'id') {
      continue;
    }
    const held = values.get(gap.address.id);
    if (held !== undefined) {
      values.set(gap.address.id, { ...held, policyIssues: [...(held.policyIssues ?? []), gap] });
    }
  }
  return {
    ...view,
    narrativeFamilies: { ...view.narrativeFamilies, values },
    issues: [...gaps, ...view.issues],
  };
}

/** The degraded completion has one synchronous, read-only policy pass and no second effects attempt. */
export function revalidateFamilyPolicy(
  db: SqliteHandle,
  view: ResolvedEvidenceView,
  context: CheckedReadContext,
  candidates: readonly FusedItem[],
): ResolvedEvidenceView {
  if (view.narrativeFamilies === undefined) {
    return view;
  }
  const reading = revalidateNarrativeRepresentations(db, view.narrativeFamilies.values, context);
  const refreshed = reading.rereadIds;
  const owned = new Set(
    [...view.narrativeFamilies.values].flatMap(([id, value]) =>
      refreshed.has(id) ? (value.policyIssues ?? []) : [],
    ),
  );
  const retained = view.issues.filter(
    (issue) =>
      !(issue.address.kind === 'id' && refreshed.has(issue.address.id) && owned.has(issue)),
  );
  return discloseFamilyGaps(
    {
      ...view,
      narrativeFamilies: { ...view.narrativeFamilies, values: reading.values },
      issues: [...reading.issues, ...retained],
    },
    candidates,
  );
}
