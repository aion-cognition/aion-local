import {
  ChunkDependencySet,
  incomingStatementScopes,
  relationScopeReadings,
  resolveChunkMembers,
  type ResolvedMembers,
  type UnprovedScope,
} from './chunk-evidence.js';
import type { EvidenceResolver } from '../../evidence/application/resolver.js';
import { DURABLE_ROLES, nodeRoleScope, type DurableRole } from '../../evidence/domain/scopes.js';
import type { EvidenceDependency } from '../../infrastructure/publication/preconditions.js';
import {
  committedIncidenceForNode,
  committedLinkVersions,
} from '../../infrastructure/sqlite/committed-evidence.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { listStatedLinksTo } from '../../infrastructure/sqlite/evidence-links.js';
import type { CheckedReadContext } from '../../recall/application/coverage-checker.js';
import { transitionEndpoints } from '../domain/chunk-revision.js';
import { hashContent } from '../domain/content.js';

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

/**
 * The population `sourcesBehind` consults beyond the two statement roles.
 *
 * It is bound where a census has counted it and left unblocked where none has. This read is a
 * positive lookup, so an uncounted absence is not what it rests on; what it does rest on is the
 * selected link itself, which the selection below carries to the content boundary.
 */
const DERIVATION_ROLES: readonly DurableRole[] = ['stated_derivation'];

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
/** One standing statement, named by the link version that makes it stand. */
type StatementFact = {
  readonly linkId: string;
  readonly fromId: string;
  readonly version: number;
};

/**
 * The statements about this endpoint that currently stand.
 *
 * Composed from the two committed-view readers rather than a third spelling of their predicate:
 * the link chain names who stated what, and the newest committed version of each link decides
 * whether it still holds. A retired statement drops out here, which is what keeps the required
 * set from accumulating every correction that was ever made.
 */
function currentStatementFacts(
  db: SqliteHandle,
  endpointId: string,
  kinds: ReadonlySet<string>,
): readonly StatementFact[] {
  const byLink = new Map<string, string>();
  for (const link of listStatedLinksTo(db, endpointId)) {
    if (kinds.has(link.kind) && link.fromId !== undefined) {
      byLink.set(link.linkId, link.fromId);
    }
  }
  const facts: StatementFact[] = [];
  for (const [linkId, fromId] of byLink) {
    const latest = committedLinkVersions(db, linkId).at(-1);
    if (latest !== undefined && latest.state !== 'retired') {
      facts.push({ linkId, fromId, version: latest.version });
    }
  }
  return facts;
}

function currentStatementSources(
  db: SqliteHandle,
  endpointId: string,
  kinds: ReadonlySet<string> = STATEMENT_KINDS,
): readonly string[] {
  return currentStatementFacts(db, endpointId, kinds).map((fact) => fact.fromId);
}

/** One incidence row that carries this endpoint now, named by the census that counts it. */
type IncidenceFact = {
  readonly sourceId: string;
  readonly role: string;
};

/**
 * One endpoint's answer, with the records it was taken from.
 *
 * The source list alone is not the reading. A link retired between the selection and the content
 * read leaves its source in the required set with nothing standing behind it, and the source's own
 * later reference token cannot certify the earlier selection any more than a later token could
 * certify a negative lookup. So the selected link versions and incidence rows travel with the
 * answer, and the boundary that follows asks the records whether they still say this.
 *
 * The incidence reader returns closed rows for the consumer to interpret, and interpreting them is
 * this reader's job: a row that has lost currency is a statement about what USED to carry the
 * endpoint. It is dropped from the selection and kept in the fingerprint, because a row going
 * closed is exactly the move the boundary has to notice.
 */
type EndpointSelection = {
  readonly sources: readonly string[];
  /** The rows the answer rests on, current ones only. */
  readonly incidence: readonly IncidenceFact[];
  readonly facts: string;
};

function sourcesBehind(db: SqliteHandle, endpointId: string): EndpointSelection {
  const carrying = committedIncidenceForNode(db, endpointId);
  const current = carrying.filter((row) => row.currency === 'open');
  // The same committed reading the standing set uses, so one statement is not evidence here and
  // absent there. A statement whose operation nobody acknowledged is durable and invisible.
  const stating = currentStatementFacts(db, endpointId, STANDING_AND_DERIVATION);
  const incidence = carrying.map((row) => [
    row.sourceId,
    row.role,
    row.currency,
    row.linkId,
    row.linkVersion,
  ]);
  const statements = stating.map((fact) => [fact.linkId, fact.fromId, fact.version]);
  return {
    sources: [
      ...new Set([...current.map((row) => row.sourceId), ...stating.map((fact) => fact.fromId)]),
    ],
    incidence: current.map((row) => ({ sourceId: row.sourceId, role: row.role })),
    facts: hashContent([
      [...incidence].sort((left, right) => String(left).localeCompare(String(right))),
      [...statements].sort((left, right) => String(left).localeCompare(String(right))),
    ]),
  };
}

const DURABLE_ROLE_SET = new Set<string>(DURABLE_ROLES);

/**
 * The census scopes standing behind the incidence rows this endpoint's answer rests on.
 *
 * A local comparison dies with the call that made it, and the retirement that matters lands after
 * it: the synthesis and the publication both run on a selection nothing is fencing. So each
 * selected row contributes the scope its census is filed under, which the publication's own
 * equality check reads back. A role the registry does not name is a fact whose census cannot be
 * named either, so it is reported uncounted and withholds rather than passing unbound.
 */
type IncidenceBinding = {
  readonly dependencies: readonly EvidenceDependency[];
  readonly unproved: readonly UnprovedScope[];
};

function selectedIncidenceScopes(
  db: SqliteHandle,
  endpointId: string,
  incidence: readonly IncidenceFact[],
): IncidenceBinding {
  const roles = [...new Set(incidence.map((row) => row.role))];
  const named = roles.filter((role): role is DurableRole => DURABLE_ROLE_SET.has(role));
  const reading = relationScopeReadings(db, endpointId, named.map(nodeRoleScope));
  return {
    dependencies: reading.dependencies,
    unproved: [
      ...reading.unproved,
      ...roles
        .filter((role) => !DURABLE_ROLE_SET.has(role))
        .map((role) => ({ sourceId: endpointId, scope: `sqlite:${role}` })),
    ],
  };
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

export type StandingWalk = {
  readonly proofs: readonly RequirementProof[];
  readonly truncated: boolean;
  /** The tokens the consulted populations were read under, taken BEFORE they were read. */
  readonly dependencies: readonly EvidenceDependency[];
  /** Consulted populations no census has counted. Unknown completeness holds the publication. */
  readonly unproved: readonly UnprovedScope[];
};

/**
 * Every source whose statement the revision currently depends on, breadth-first from its members.
 *
 * The proof travels with each one: which interpretation it speaks about and how far that is from
 * a frozen member. Nothing is accumulated between runs — the whole set is re-derived — so a
 * requirement disappears exactly when the statement that made it required stops standing, and a
 * refinement of a withdrawn correction goes with the correction it refined.
 *
 * Each endpoint's incoming-statement populations are bound BEFORE they are read, and that ordering
 * is the point. "Nothing else corrects this correction" is a negative reading the whole requirement
 * rests on, and a token acquired afterwards dates a different moment: a refinement accepted between
 * the walk and the resolver's read would be certified by a token that already knew about it. Bound
 * first, the token is the one the derivation actually stood on, and the publication's own check
 * refuses it once the population moves.
 */
function standingRequirement(
  db: SqliteHandle,
  members: ReadonlySet<string>,
  seeds: readonly string[],
): StandingWalk {
  const proofs: RequirementProof[] = [];
  const dependencies: EvidenceDependency[] = [];
  const unproved: UnprovedScope[] = [];
  const seen = new Set<string>(seeds);
  let frontier = [...seeds];
  for (let depth = 1; depth <= TRANSITION_DEPTH_LIMIT && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const about of frontier) {
      const census = incomingStatementScopes(db, about);
      dependencies.push(...census.dependencies);
      unproved.push(...census.unproved);
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
      return {
        proofs: proofs.slice(0, TRANSITION_EVIDENCE_LIMIT),
        truncated: true,
        dependencies,
        unproved,
      };
    }
    frontier = next;
  }
  return { proofs, truncated: frontier.length > 0, dependencies, unproved };
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
  const bound = new ChunkDependencySet();
  const unprovedScopes: UnprovedScope[] = [...standing.unproved];
  // The discovery tokens go in FIRST and stay: the set keeps the earliest reading of a scope and
  // marks a later disagreeing one as a conflict, so the resolver's newer token cannot quietly
  // replace the one the requirement was derived under.
  bound.addAll(standing.dependencies);
  const unresolved: string[] = [];
  /** Each endpoint's selection, by the records it was taken from, kept for the boundary below. */
  const selected = new Map<string, string>();
  for (const endpointId of endpoints) {
    // A member's own changed scope is not an endpoint to walk: the member is already being read
    // as a member, and what currently stands about it is the standing set's answer. Walking it
    // here would union its incidence back in and keep a withdrawn statement required forever.
    if (members.has(endpointId)) {
      continue;
    }
    // The statement populations, on the same terms the walk binds its own.
    const census = incomingStatementScopes(deps.db, endpointId);
    bound.addAll(census.dependencies);
    unprovedScopes.push(...census.unproved);
    // The derivation half of `sourcesBehind` is bound too, before the selection reads it. An
    // uncounted census does not hold the regrounding, since this is a positive lookup rather than
    // a completeness reading. Where one has been counted, the token makes a retirement visible to
    // the publication's own equality check as well as to the boundary below.
    bound.addAll(incomingStatementScopes(deps.db, endpointId, DERIVATION_ROLES).dependencies);
    const selection = sourcesBehind(deps.db, endpointId);
    const behind = selection.sources.filter((sourceId) => !members.has(sourceId));
    if (behind.length === 0) {
      unresolved.push(endpointId);
      continue;
    }
    // Only the rows that put an outsider in the required set: a member is read as a member, and
    // its incidence is not what this requirement stands on.
    const incidence = selectedIncidenceScopes(
      deps.db,
      endpointId,
      selection.incidence.filter((row) => !members.has(row.sourceId)),
    );
    bound.addAll(incidence.dependencies);
    unprovedScopes.push(...incidence.unproved);
    selected.set(endpointId, selection.facts);
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
  bound.addAll(resolved.dependencies);
  unprovedScopes.push(...resolved.unprovedScopes);
  // The content read happens after the selection, so the selection is re-asked of the records once
  // that read is done. A statement retired or an incidence moved in between makes the requirement
  // one nobody now stands behind, and this revision publishes on the records or not at all.
  const moved = [...selected]
    .filter(([endpointId, facts]) => sourcesBehind(deps.db, endpointId).facts !== facts)
    .map(([endpointId]) => endpointId);
  return {
    readings: [
      ...resolved.readings,
      // An endpoint nobody can resolve reaches the plan as a requirement that read unreadable,
      // which is the refusal it is, rather than as a requirement that quietly went away.
      ...[...unresolved, ...overflow, ...moved].map((sourceId) => ({
        sourceId,
        reading: 'unreadable' as const,
      })),
    ],
    dependencies: bound.list(),
    unresolved,
    requirement: standing.proofs,
    truncated: standing.truncated,
    // The transition sources' incoming-statement scopes ARE what this revision rests on, since the
    // walk asked those populations whether anything further corrects a requirement. An uncounted
    // one leaves that question unanswered, and an unanswered completeness holds the publication
    // rather than passing for a proved empty.
    unprovedScopes,
  };
}
