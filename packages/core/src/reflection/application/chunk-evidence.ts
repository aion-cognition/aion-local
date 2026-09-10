import { readRelationScope } from '../../evidence/application/dependencies.js';
import type { EvidenceResolver } from '../../evidence/application/resolver.js';
import type { SourceEvidence } from '../../evidence/application/sources.js';
import { idAddress, evidenceRequestKey } from '../../evidence/domain/address.js';
import type { EvidenceIssue, EvidenceResult } from '../../evidence/domain/result.js';
import { durableRoleScope } from '../../evidence/domain/scopes.js';
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
const INCOMING_STATEMENT_ROLES = ['stated_correction', 'stated_confirmation'] as const;

export type UnprovedScope = {
  readonly sourceId: string;
  readonly scope: string;
};

type ScopeReading = {
  readonly dependencies: readonly EvidenceDependency[];
  readonly unproved: readonly UnprovedScope[];
};

function incomingStatementScopes(db: SqliteHandle, sourceId: string): ScopeReading {
  const dependencies: EvidenceDependency[] = [];
  const unproved: UnprovedScope[] = [];
  for (const role of INCOMING_STATEMENT_ROLES) {
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
): Promise<ResolvedMembers> {
  if (sourceIds.length === 0) {
    return { readings: [], dependencies: [], unprovedScopes: [] };
  }
  const batch = await resolver.resolveSources(
    sourceIds.map(idAddress),
    context,
    NARRATIVE_MEMBER_USE,
    { required: true },
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
 * The same read for one source, in an allowance of its own.
 *
 * A batch that ran out of room reports `budget_limit` for every address it could not reach, which
 * says nothing about whether any one of them is over the bound by itself. The size class AD-2
 * turns on is exactly that question, so it is asked one source at a time: a source that answers
 * completely in its own allowance is one the resolver can serve whole, and one that does not is
 * the block class no bounded submission is defined for.
 */
export async function resolveChunkMemberAlone(
  resolver: EvidenceResolver,
  sourceId: string,
  context: CheckedReadContext,
): Promise<ChunkMemberEvidence> {
  const batch = await resolver.resolveSources(
    [idAddress(sourceId)],
    context,
    NARRATIVE_MEMBER_USE,
    {
      required: true,
      budget: resolver.newBudget(),
    },
  );
  const result = batch.results.get(evidenceRequestKey(idAddress(sourceId)));
  const reading = readingOf(result);
  return reading === 'complete' && result?.value !== undefined
    ? { sourceId, reading, text: memberTextOf(result.value) }
    : { sourceId, reading };
}
