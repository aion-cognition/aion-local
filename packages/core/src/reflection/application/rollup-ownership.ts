import type { NarrativeRepresentation } from '../../evidence/application/narrative-representation.js';
import type { EvidenceIssue } from '../../evidence/domain/result.js';
import type { RollupLineage } from '../../infrastructure/graph/narrative-rollup-queries.js';

/**
 * Whether one identity is this writer's to publish over, absorb or close.
 *
 * One predicate, and both sides of the publication run it: the pass runs it on the reading it
 * takes before it spends a model call, and the handler runs it again on a fresh reading under the
 * guard. Keeping it in one place is what makes those two answers the same question.
 *
 * Ownership is POSITIVE. An answer the adapter could not prove is not permission, because the
 * adapter's uncertainty is uncertainty about the family and not evidence of a session that never
 * chose one. The way a genuinely uninitialized legacy session becomes publishable is the producer:
 * the writer initializes the preference through the coordinator and reads the recorded answer.
 * Nothing here mints that answer, and nothing here reads a marker.
 */

/** The families that publish through a manifest of their own. Never this writer's to close. */
const SIGNED_FAMILIES = ['chunk', 'overview'];

/**
 * The one unproved answer the producer can repair.
 *
 * `unverified_scope` on the preference axis is what the adapter reports for a session whose
 * choice was never recorded, and for one whose recorded choice carries no established proof
 * counter. Neither is permission and neither is inferred here: both go to the producer, which
 * records the first and refuses the second by name.
 */
export const UNRECORDED_PREFERENCE = 'legacy_family_unproved:unverified_scope';

export type RollupOwnership =
  | { readonly status: 'owned' }
  /** Another family's node. It is not a version here, and closing it is not this writer's to do. */
  | { readonly status: 'foreign' }
  | { readonly status: 'unproved'; readonly reason: string };

export type OwnershipReading = {
  readonly values: ReadonlyMap<string, NarrativeRepresentation>;
  readonly issues: readonly EvidenceIssue[];
};

/**
 * The family axis and the publication axis stay apart.
 *
 * `representation_preference` is a question about which representation a session selects;
 * `narrative_revision` is a question about whether a publication is established. A reader that
 * collapsed them would report a pending acknowledgment as a family it could not read.
 */
function issueReason(issues: readonly EvidenceIssue[], id: string): string | undefined {
  const held = issues.find(
    (issue) => issue.required && issue.address.kind === 'id' && issue.address.id === id,
  );
  if (held === undefined) {
    return undefined;
  }
  return held.field === 'representation_preference'
    ? `legacy_family_unproved:${held.reason}`
    : `legacy_publication_unproved:${held.reason}`;
}

function ownershipOf(id: string, reading: OwnershipReading): RollupOwnership {
  const value = reading.values.get(id);
  if (value === undefined) {
    return { status: 'unproved', reason: 'legacy_family_unanswered' };
  }
  if (SIGNED_FAMILIES.includes(value.family)) {
    return { status: 'foreign' };
  }
  if (value.family !== 'legacy_session_overview') {
    // A calendar summary belongs to no session of its own, so what proves it is what it rests on.
    // The adapter says as much by reporting an unresolved preference for it, which is a fact about
    // this node rather than doubt about a session, and an empty ancestry still proves nothing.
    return { status: 'unproved', reason: 'legacy_ancestry_unproved' };
  }
  const issue = issueReason(reading.issues, id);
  if (issue !== undefined) {
    return { status: 'unproved', reason: issue };
  }
  if (value.selection === 'not_selected') {
    return { status: 'unproved', reason: 'legacy_family_changed' };
  }
  if (value.selection !== 'selected') {
    return { status: 'unproved', reason: UNRECORDED_PREFERENCE };
  }
  if (value.publication !== 'established') {
    return { status: 'unproved', reason: 'legacy_publication_unproved:unrecorded' };
  }
  return { status: 'owned' };
}

/**
 * One candidate and everything underneath it.
 *
 * A calendar summary is owned when its ancestry is owned, so the walk decides both the summary
 * and the retired session narrative it absorbed before the cutover. A foreign ancestor is not a
 * refusal of the candidate; it is proof the candidate is not this family's, which is the same
 * answer as a foreign candidate.
 */
export function rollupOwnership(
  id: string,
  reading: OwnershipReading,
  lineage: ReadonlyMap<string, RollupLineage>,
): RollupOwnership {
  const own = ownershipOf(id, reading);
  if (own.status === 'foreign') {
    return own;
  }
  if (own.status === 'unproved' && own.reason !== 'legacy_ancestry_unproved') {
    return own;
  }
  const ancestors = lineage.get(id)?.ancestors ?? [];
  let proved = 0;
  for (const ancestor of ancestors) {
    const held = ownershipOf(ancestor, reading);
    if (held.status === 'owned') {
      proved += 1;
      continue;
    }
    if (held.status === 'foreign') {
      return held;
    }
    if (held.reason !== 'legacy_ancestry_unproved') {
      return held;
    }
    // A calendar summary underneath a calendar summary. The walk is transitive, so whatever
    // proves that one is already in this same set and is counted there.
  }
  if (own.status === 'owned') {
    return own;
  }
  return proved > 0
    ? { status: 'owned' }
    : { status: 'unproved', reason: 'legacy_ancestry_unproved' };
}

/** Whether the producer can repair this answer, which is true of exactly one of them. */
export function isUnrecorded(ownership: RollupOwnership): boolean {
  return ownership.status === 'unproved' && ownership.reason === UNRECORDED_PREFERENCE;
}

/** Every session the reading named for these identities, which is who the producer initializes. */
export function readingSessions(
  ids: readonly string[],
  reading: OwnershipReading,
): readonly string[] {
  const sessions = new Set<string>();
  for (const id of ids) {
    const value = reading.values.get(id);
    if (value === undefined || SIGNED_FAMILIES.includes(value.family)) {
      continue;
    }
    for (const sessionId of value.sessions) {
      sessions.add(sessionId);
    }
  }
  return [...sessions].sort();
}
