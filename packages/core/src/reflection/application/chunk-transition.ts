import { resolveChunkMembers, type ResolvedMembers } from './chunk-evidence.js';
import type { EvidenceResolver } from '../../evidence/application/resolver.js';
import type { EvidenceDependency } from '../../infrastructure/publication/preconditions.js';
import {
  committedIncidenceForNode,
  committedLinkVersions,
} from '../../infrastructure/sqlite/committed-evidence.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { listStatedLinksTo } from '../../infrastructure/sqlite/evidence-links.js';
import type { CheckedReadContext } from '../../recall/application/coverage-checker.js';
import { transitionEndpoints } from '../domain/chunk-revision.js';

/**
 * The evidence a revision is required to submit beside its members, and where it comes from.
 *
 * The set is the CURRENT requirement, not the delta since the last head. A token that moved says
 * work is owed; it does not say what the answer needs. Assembling only the delta drops a
 * correction that is still applicable the moment a second one arrives — the new revision then
 * claims current coverage over an interpretation whose first correction never reached the prompt —
 * and it submits nothing at all on a first publication, whose changed set is empty by definition.
 *
 * So the standing requirement is read from the records: every source that CURRENTLY corrects or
 * confirms a member, which drops out on its own when the statement is retired. The delta still
 * contributes what it names outside the membership, since a changed cited node is evidence this
 * revision rested on that no statement about a member would find.
 *
 * They are external by construction. A member of this chunk that changed is already being read as
 * a member, so it is excluded here rather than resolved twice under two names.
 */

/** How many external sources one revision may pull in. A change nobody bounded is not evidence. */
export const TRANSITION_EVIDENCE_LIMIT = 16;

/**
 * Statement kinds that make their source required reading for a member's interpretation.
 *
 * `derived_from` is deliberately absent: a source deriving FROM a member says something about
 * itself, not about the member, and requiring it would pull every downstream reader into the
 * input of the thing it read.
 */
const STATEMENT_KINDS = new Set(['corrects', 'confirms']);

/**
 * What counts as a source standing behind a CHANGED endpoint, which is a wider question than what
 * a member's interpretation requires: a derivation from the endpoint is evidence about the change
 * this revision has to reground on, even though it is not a statement about a member.
 */
const STANDING_AND_DERIVATION = new Set(['corrects', 'confirms', 'derived_from']);

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
/**
 * The sources whose statement about this endpoint currently stands.
 *
 * Composed from the two committed-view readers rather than a third spelling of their predicate:
 * the link chain names who stated what, and the newest committed version of each link decides
 * whether it still holds. A retired statement drops out here, which is what keeps the required
 * set from accumulating every correction that was ever made.
 */
function currentStatementSources(
  db: SqliteHandle,
  endpointId: string,
  kinds: ReadonlySet<string> = STATEMENT_KINDS,
): readonly string[] {
  const byLink = new Map<string, string>();
  for (const link of listStatedLinksTo(db, endpointId)) {
    if (kinds.has(link.kind) && link.fromId !== undefined) {
      byLink.set(link.linkId, link.fromId);
    }
  }
  const sources: string[] = [];
  for (const [linkId, fromId] of byLink) {
    const latest = committedLinkVersions(db, linkId).at(-1);
    if (latest !== undefined && latest.state !== 'retired') {
      sources.push(fromId);
    }
  }
  return sources;
}

function sourcesBehind(db: SqliteHandle, endpointId: string): readonly string[] {
  const carrying = committedIncidenceForNode(db, endpointId).map((row) => row.sourceId);
  // The same committed reading the standing set uses, so one statement is not evidence here and
  // absent there. A statement whose operation nobody acknowledged is durable and invisible.
  const stating = currentStatementSources(db, endpointId, STANDING_AND_DERIVATION);
  return [...new Set([...carrying, ...stating])];
}

export type TransitionEvidence = ResolvedMembers & {
  /** Endpoints whose changed evidence resolved to no source at all, named rather than dropped. */
  readonly unresolved: readonly string[];
  /** Why each external input is required: what it speaks about, and how far from a member. */
  readonly requirement: readonly RequirementProof[];
  /** True when the walk hit a bound before it finished. The overflow refuses rather than drops. */
  readonly truncated: boolean;
};

export type RequirementProof = {
  readonly sourceId: string;
  /** The interpretation it currently speaks about, which is what makes it required. */
  readonly about: string;
  /** Hops from a frozen member. One is a direct statement about a member. */
  readonly depth: number;
};

/**
 * How far a requirement chain is followed.
 *
 * A correction of a correction is still evidence about the member's interpretation, and stopping
 * at one hop lost it the moment anything else changed. Following it forever is the other failure:
 * the walk is bounded in depth and in count, it never revisits an endpoint, and what it could not
 * reach refuses rather than disappearing.
 */
export const TRANSITION_DEPTH_LIMIT = 4;

/**
 * Every source whose statement the revision currently depends on, breadth-first from its members.
 *
 * The proof travels with each one: which interpretation it speaks about and how far that is from
 * a frozen member. Nothing is accumulated between runs — the whole set is re-derived — so a
 * requirement disappears exactly when the statement that made it required stops standing, and a
 * refinement of a withdrawn correction goes with the correction it refined.
 */
function standingRequirement(
  db: SqliteHandle,
  members: ReadonlySet<string>,
  seeds: readonly string[],
): { readonly proofs: readonly RequirementProof[]; readonly truncated: boolean } {
  const proofs: RequirementProof[] = [];
  const seen = new Set<string>(seeds);
  let frontier = [...seeds];
  for (let depth = 1; depth <= TRANSITION_DEPTH_LIMIT && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const about of frontier) {
      for (const sourceId of currentStatementSources(db, about)) {
        // A member is read as a member, and an endpoint already walked is a cycle rather than a
        // second requirement.
        if (members.has(sourceId) || seen.has(sourceId)) {
          continue;
        }
        seen.add(sourceId);
        proofs.push({ sourceId, about, depth });
        next.push(sourceId);
      }
    }
    if (proofs.length > TRANSITION_EVIDENCE_LIMIT) {
      return { proofs: proofs.slice(0, TRANSITION_EVIDENCE_LIMIT), truncated: true };
    }
    frontier = next;
  }
  return { proofs, truncated: frontier.length > 0 };
}

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
  const members = new Set(frozenMembers);
  const { endpoints } = transitionEndpoints(changed);
  // A changed SOURCE dependency nominates the work; it does not define the evidence. A source
  // whose own records moved is either a member, read as one, or an outsider whose statements
  // about this chunk the standing set below decides on. Requiring it because its token moved is
  // what kept a withdrawn correction in the input for good.
  // The standing requirement, re-derived every time rather than accumulated: whoever currently
  // corrects or confirms a member, and whoever currently corrects or confirms THEM, bounded.
  const standing = standingRequirement(deps.db, members, frozenMembers);
  const required = new Set(standing.proofs.map((proof) => proof.sourceId));
  const unresolved: string[] = [];
  for (const endpointId of endpoints) {
    // A member's own changed scope is not an endpoint to walk: the member is already being read
    // as a member, and what currently stands about it is the standing set's answer. Walking it
    // here would union its incidence back in and keep a withdrawn statement required forever.
    if (members.has(endpointId)) {
      continue;
    }
    const behind = sourcesBehind(deps.db, endpointId).filter((sourceId) => !members.has(sourceId));
    if (behind.length === 0) {
      unresolved.push(endpointId);
      continue;
    }
    for (const sourceId of behind) {
      required.add(sourceId);
    }
  }
  const ordered = [...required].sort();
  const bounded = standing.truncated ? [] : ordered.slice(0, TRANSITION_EVIDENCE_LIMIT);
  // A requirement past the bound is not read, and an unread requirement is an unavailable one.
  // Dropping the overflow would publish a regrounding that omitted a correction without saying so.
  const overflow = standing.truncated ? ordered : ordered.slice(TRANSITION_EVIDENCE_LIMIT);
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
    requirement: standing.proofs,
    truncated: standing.truncated,
    // The transition sources' own incoming-statement scopes are not what this revision rests on:
    // what it needs from them is their content. An unproved scope on a correction holds nothing.
    unprovedScopes: [],
  };
}
