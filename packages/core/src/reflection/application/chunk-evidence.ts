import { readRelationScope } from '../../evidence/application/dependencies.js';
import type { EvidenceResolver } from '../../evidence/application/resolver.js';
import type { SourceEvidence } from '../../evidence/application/sources.js';
import { idAddress, evidenceRequestKey } from '../../evidence/domain/address.js';
import type { RequestBudget } from '../../evidence/domain/budget.js';
import type { EvidenceIssue, EvidenceResult } from '../../evidence/domain/result.js';
import { durableRoleScope, type DurableRole } from '../../evidence/domain/scopes.js';
import type { EvidenceDependency } from '../../infrastructure/publication/preconditions.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { sourcePartAddress } from '../../infrastructure/sqlite/source-identity.js';
import type { CheckedReadContext } from '../../recall/application/coverage-checker.js';
import type { ChunkMemberText } from '../domain/chunk-render.js';
import type { ChunkEvidenceReading, ChunkMemberEvidence } from '../domain/chunk-revision.js';

/**
 * Turning the resolver's four-dimensional answer into the one word the chunk decisions need.
 *
 * The resolver already separates a proved suppression from a store that could not answer and both
 * from an exhausted allowance, and every chunk rule downstream turns on that distinction: proved
 * suppression is a gap the revision publishes with, a bound is a block, and anything unproved is a
 * block too. Reading them off a single "did it work" boolean is how an unknown becomes a gap.
 */

/** The purpose these reads are made for, which is what applies suppression to them. */
export const NARRATIVE_MEMBER_USE = 'narrative_member' as const;

function issuesOf(result: EvidenceResult<SourceEvidence>): readonly EvidenceIssue[] {
  return result.evidence.status === 'complete-for-use' ? [] : result.evidence.reasons;
}

const UNREADABLE = new Set([
  'unresolved_mapping',
  'store_unavailable',
  'pending_publication',
  'not_found',
]);

export function readingOf(
  result: EvidenceResult<SourceEvidence> | undefined,
): ChunkEvidenceReading {
  if (result === undefined) {
    return 'unreadable';
  }
  if (result.evidence.status === 'complete-for-use' && result.value !== undefined) {
    return 'complete';
  }
  const reasons = issuesOf(result).map((issue) => issue.reason);
  if (reasons.includes('suppressed_source')) {
    return 'suppressed';
  }
  if (reasons.includes('budget_limit')) {
    return 'over_budget';
  }
  return reasons.some((reason) => UNREADABLE.has(reason)) ? 'unreadable' : 'unproved';
}

/**
 * The member in the form the chunk renderer places, addressed the way a citation would name it.
 *
 * `sourceText` rather than the addressed slice: a chunk member is the whole captured experience,
 * and the parts carry their own addresses so a bounded submission can name exactly what it sent.
 */
export function memberTextOf(evidence: SourceEvidence): ChunkMemberText {
  return {
    sourceId: evidence.sourceId,
    occurredAt: new Date(evidence.occurredAt),
    text: evidence.sourceText,
    parts: evidence.parts.map((part) => ({
      address: sourcePartAddress(evidence.sourceId, part.partKind, part.ordinal),
      text: part.text,
    })),
  };
}

export type ResolvedMembers = {
  readonly readings: readonly ChunkMemberEvidence[];
  readonly dependencies: readonly EvidenceDependency[];
  /**
   * Scopes this read needed and could not bind. A caller publishing on them would certify an
   * answer nothing can later invalidate; a caller only sealing may ignore them, because the
   * membership question does not rest on what has been said about a member.
   */
  readonly unprovedScopes: readonly UnprovedScope[];
};

/**
 * The negative scopes a narrative revision reads without finding anything.
 *
 * "Nothing corrects this" and "nothing confirms this" are readings a revision rests on as surely
 * as the text itself, and a revision fenced only on its members' own records goes on standing
 * after a correction arrives. Each is bound at its own token where a census has counted the scope.
 *
 * Where none has, the reader binds nothing AND says so. Silently omitting the dependency was the
 * defect: it read as a publishable input, and the revision it produced had no scope for a later
 * correction to invalidate — the answer would stand for good. A reader may not mint a census, so
 * the uncertainty travels to the plan and holds the publication instead.
 */
const INCOMING_STATEMENT_ROLES: readonly DurableRole[] = [
  'stated_correction',
  'stated_confirmation',
];

export type UnprovedScope = {
  readonly sourceId: string;
  readonly scope: string;
};

export type IncomingScopeReading = {
  readonly dependencies: readonly EvidenceDependency[];
  readonly unproved: readonly UnprovedScope[];
};

/**
 * One source's incoming-statement populations, bound where a census has counted them.
 *
 * Exported because the transitive requirement walk consults the same populations and has to bind
 * them under the same rule. A second spelling of this read would be a second answer to whether an
 * absence is proved.
 */
export function incomingStatementScopes(
  db: SqliteHandle,
  sourceId: string,
  roles: readonly DurableRole[] = INCOMING_STATEMENT_ROLES,
): IncomingScopeReading {
  const dependencies: EvidenceDependency[] = [];
  const unproved: UnprovedScope[] = [];
  for (const role of roles) {
    const scope = durableRoleScope(role, 'in');
    const reading = readRelationScope(db, {
      kind: 'relation_scope',
      endpointId: sourceId,
      scope,
      empty: false,
    });
    if (reading.status === 'verified') {
      dependencies.push(reading.dependency);
    } else {
      unproved.push({ sourceId, scope });
    }
  }
  return { dependencies, unproved };
}

/**
 * Whether the census now covers every scope a blocked revision could not count.
 *
 * The same read the refusal was taken from, asked again. A scheduler cannot re-derive this from the
 * block reason: `member_scope_census_missing` says a required scope was uncounted at the time, and
 * only the scope records say whether it is counted now. Absence is still not proof — a scope that
 * reads anything other than `verified` leaves the block standing, which is the uncounted case and
 * the unreadable one alike.
 */
export function memberScopesCounted(db: SqliteHandle, sourceIds: readonly string[]): boolean {
  return sourceIds.every((sourceId) => incomingStatementScopes(db, sourceId).unproved.length === 0);
}

/**
 * Whether the EXACT scopes a refusal could not count are counted now.
 *
 * Asking about the frozen members instead asks a narrower question than the refusal did: a
 * requirement the transitive walk reached is not a member of the chunk, so a chunk blocked on an
 * external requirement's uncounted census reads as cleared, publishes nothing, and blocks again on
 * the next run. The set the attempt recorded is the set the wakeup has to ask about.
 */
export function scopesCounted(
  db: SqliteHandle,
  scopes: readonly { readonly sourceId: string; readonly scope: string }[],
): boolean {
  return scopes.every(
    (entry) =>
      readRelationScope(db, {
        kind: 'relation_scope',
        endpointId: entry.sourceId,
        scope: entry.scope,
        empty: false,
      }).status === 'verified',
  );
}

/**
 * One batched read for a set of sources, classified per source.
 *
 * The dependency set travels with it: what a revision fences on is what its own read observed, and
 * a set rebuilt later from a second read would be a different reading with the same name.
 */
export async function resolveChunkMembers(
  resolver: EvidenceResolver,
  db: SqliteHandle,
  sourceIds: readonly string[],
  context: CheckedReadContext,
  budget?: RequestBudget,
): Promise<ResolvedMembers> {
  if (sourceIds.length === 0) {
    return { readings: [], dependencies: [], unprovedScopes: [] };
  }
  const batch = await resolver.resolveSources(
    sourceIds.map(idAddress),
    context,
    NARRATIVE_MEMBER_USE,
    { required: true, ...(budget === undefined ? {} : { budget }) },
  );
  const readings = sourceIds.map((sourceId): ChunkMemberEvidence => {
    const result = batch.results.get(evidenceRequestKey(idAddress(sourceId)));
    const reading = readingOf(result);
    return reading === 'complete' && result?.value !== undefined
      ? { sourceId, reading, text: memberTextOf(result.value) }
      : { sourceId, reading };
  });
  const scopes = sourceIds.map((sourceId) => incomingStatementScopes(db, sourceId));
  return {
    readings,
    dependencies: [
      ...batch.revision.dependencies,
      ...scopes.flatMap((reading) => reading.dependencies),
    ],
    unprovedScopes: scopes.flatMap((reading) => reading.unproved),
  };
}

/**
 * One request's dependency set, folded from every read that contributed to it.
 *
 * Two readings of one scope that disagree are not a set to merge. The later one is not "fresher":
 * they are two moments, and a revision fenced on either alone claims a coherence it never had. The
 * disagreement is recorded against the endpoint it names so the caller can fail that reading
 * instead of publishing on a token it picked.
 */
export class ChunkDependencySet {
  readonly #held = new Map<string, EvidenceDependency>();
  readonly #conflicts = new Set<string>();

  addAll(dependencies: readonly EvidenceDependency[]): void {
    for (const dependency of dependencies) {
      const key = `${dependency.kind}|${dependency.id}|${dependency.scope}`;
      const held = this.#held.get(key);
      if (held !== undefined && held.version !== dependency.version) {
        this.#conflicts.add(dependency.id);
        continue;
      }
      this.#held.set(key, dependency);
    }
  }

  /** Whether any scope on this endpoint was read two ways. */
  conflicted(id: string): boolean {
    return this.#conflicts.has(id);
  }

  list(): readonly EvidenceDependency[] {
    return [...this.#held.values()];
  }
}

/**
 * The same read for one source, in an allowance of its own.
 *
 * A batch that ran out of room reports `budget_limit` for every address it could not reach, which
 * says nothing about whether any one of them is over the bound by itself. The size class AD-2
 * turns on is exactly that question, so it is asked one source at a time: a source that answers
 * completely in its own allowance is one the resolver can serve whole, and one that does not is
 * the block class no bounded submission is defined for.
 *
 * It returns the whole reading, dependencies and unproved scopes included. Taking only the text
 * was the defect: an address the batch never reached acquires its source dependencies HERE, and a
 * revision that kept the batch's set alone was fenced on nothing for that member.
 */
export async function resolveChunkMemberAlone(
  resolver: EvidenceResolver,
  db: SqliteHandle,
  sourceId: string,
  context: CheckedReadContext,
): Promise<ResolvedMembers> {
  return resolveChunkMembers(resolver, db, [sourceId], context, resolver.newBudget());
}
