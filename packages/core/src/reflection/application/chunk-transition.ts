import { resolveChunkMembers, type ResolvedMembers } from './chunk-evidence.js';
import type { EvidenceResolver } from '../../evidence/application/resolver.js';
import type { EvidenceDependency } from '../../infrastructure/publication/preconditions.js';
import { committedIncidenceForNode } from '../../infrastructure/sqlite/committed-evidence.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { listStatedLinksTo } from '../../infrastructure/sqlite/evidence-links.js';
import type { CheckedReadContext } from '../../recall/application/coverage-checker.js';
import { transitionEndpoints } from '../domain/chunk-revision.js';

/**
 * The evidence a regrounding is required to submit, and where it comes from.
 *
 * A changed dependency token proves the READ was fresh. It proves nothing about what entered the
 * prompt, and a revision written without the correction that invalidated it would be certified as
 * current complete coverage over an interpretation nobody corrected. So the change itself is
 * resolved back to the sources that carry it — the superseding claim's own source, the correction's
 * source — and those sources are submitted beside the frozen members.
 *
 * They are external by construction. A member of this chunk that changed is already being read as
 * a member, so it is excluded here rather than resolved twice under two names.
 */

/** How many external sources one regrounding may pull in. A change nobody bounded is not evidence. */
export const TRANSITION_EVIDENCE_LIMIT = 16;

export type TransitionDeps = {
  readonly db: SqliteHandle;
  readonly resolver: EvidenceResolver;
};

/**
 * The sources behind a changed endpoint: what carries it now, and what has been stated about it.
 *
 * Both directions are read because a change can arrive either way. A node whose incidence moved
 * changed because some source now carries it; a node somebody corrected changed because another
 * source made a statement about it, and the statement's own source is the one the regrounding has
 * to read.
 */
function sourcesBehind(db: SqliteHandle, endpointId: string): readonly string[] {
  const carrying = committedIncidenceForNode(db, endpointId).map((row) => row.sourceId);
  const stating = listStatedLinksTo(db, endpointId).flatMap((link) =>
    link.fromId === undefined || link.knownFrom === null ? [] : [link.fromId],
  );
  return [...new Set([...carrying, ...stating])];
}

export type TransitionEvidence = ResolvedMembers & {
  /** Endpoints whose changed evidence resolved to no source at all, named rather than dropped. */
  readonly unresolved: readonly string[];
};

/**
 * Resolves the AD-1 required set for one regrounding.
 *
 * An endpoint that resolves to no source is named rather than passed over: the plan treats an
 * unresolvable requirement as a refusal, because a regrounding that cannot find the change it is
 * regrounding on has not been given the correction it needs.
 */
export async function chunkTransitionEvidence(
  deps: TransitionDeps,
  changed: readonly EvidenceDependency[],
  frozenMembers: readonly string[],
  context: CheckedReadContext,
): Promise<TransitionEvidence> {
  if (changed.length === 0) {
    return { readings: [], dependencies: [], unresolved: [], unprovedScopes: [] };
  }
  const members = new Set(frozenMembers);
  const { sources, endpoints } = transitionEndpoints(changed);
  const required = new Set(sources.filter((sourceId) => !members.has(sourceId)));
  const unresolved: string[] = [];
  for (const endpointId of endpoints) {
    const behind = sourcesBehind(deps.db, endpointId).filter((sourceId) => !members.has(sourceId));
    if (behind.length === 0 && !members.has(endpointId)) {
      unresolved.push(endpointId);
      continue;
    }
    for (const sourceId of behind) {
      required.add(sourceId);
    }
  }
  const ordered = [...required].sort();
  const bounded = ordered.slice(0, TRANSITION_EVIDENCE_LIMIT);
  // A requirement past the bound is not read, and an unread requirement is an unavailable one.
  // Dropping the overflow would publish a regrounding that omitted a correction without saying so.
  const overflow = ordered.slice(TRANSITION_EVIDENCE_LIMIT);
  const resolved = await resolveChunkMembers(deps.resolver, deps.db, bounded, context);
  const dependencies: EvidenceDependency[] = [...resolved.dependencies];
  return {
    readings: [
      ...resolved.readings,
      // An endpoint nobody can resolve reaches the plan as a requirement that read unreadable,
      // which is the refusal it is, rather than as a requirement that quietly went away.
      ...[...unresolved, ...overflow].map((sourceId) => ({
        sourceId,
        reading: 'unreadable' as const,
      })),
    ],
    dependencies,
    unresolved,
    // The transition sources' own incoming-statement scopes are not what this revision rests on:
    // what it needs from them is their content. An unproved scope on a correction holds nothing.
    unprovedScopes: [],
  };
}
