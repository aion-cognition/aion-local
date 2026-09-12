import { certifyNarrativeSupport } from './narrative-support.js';
import {
  countCommittedIncidenceForNode,
  countCommittedStatedLinksTo,
} from '../../infrastructure/sqlite/committed-evidence.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { STATED_LINK_KINDS } from '../../infrastructure/sqlite/evidence-links.js';
import {
  publishedScopeToken,
  scopeSupportsVerifiedEmpty,
} from '../../infrastructure/sqlite/evidence-scope.js';
import { countCitationsTo } from '../../infrastructure/sqlite/narrative-citations.js';
import { NARRATIVE_SCOPES, nodeRoleScope, type DurableRole } from '../domain/scopes.js';

/**
 * Whether the records still hold something up.
 *
 * The question a repair sweep asks before it suppresses a node: does any source still stand
 * behind this, and does any narrative still cite it. Both are asked of the durable records, so a
 * node whose raw containers are gone answers exactly as one whose containers are resident, which
 * is the difference between an evicted memory and a forgotten one.
 *
 * Three answers. `supported` means a committed record names it. `unsupported` means the census
 * for every scope that could name it has been established and none does. `unknown` means nobody
 * has counted, and it authorizes nothing: an empty read from an unbackfilled census is silence,
 * not absence.
 */
export type NodeSupport = 'supported' | 'unsupported' | 'unknown';

/**
 * The roles a source can stand behind a retained node in.
 *
 * The four incidence roles, because those are what a source records about a node it produced or
 * named. The three stated roles too: a correction, a confirmation or a derivation somebody made
 * about this node is a source standing behind it just as much, and a sweep that read only the
 * first four could suppress a node an acknowledged confirmation names.
 */
export const SUPPORT_ROLES: readonly DurableRole[] = [
  'extraction',
  'mention',
  'participation',
  'source_coverage',
  'stated_correction',
  'stated_confirmation',
  'stated_derivation',
];

/**
 * Every scope this reading rests on, at the direction the registry files each one under.
 *
 * A census writer takes its node scope set from here rather than listing its own, because a
 * census established under a scope this reader does not ask for leaves the answer unknown while
 * looking established. The citation scope is in the set because the answer moves with that
 * population, not because a census over it is required.
 */
/**
 * The statement kinds a stated link may carry. They are the wire spelling of the three stated
 * roles above: the acceptance writer records `confirms`, `corrects` and `derived_from`, and the
 * scope registry files their censuses under `stated_confirmation`, `stated_correction` and
 * `stated_derivation`.
 */
export const STATED_SUPPORT_KINDS: readonly string[] = [...STATED_LINK_KINDS];

export const NODE_SUPPORT_SCOPES: readonly string[] = [
  ...SUPPORT_ROLES.map((role) => nodeRoleScope(role)),
  NARRATIVE_SCOPES[0],
];

/**
 * The subset a source-side census may count: the incidence roles, and not the citation scope.
 *
 * The citation population is the revision records, and a pass that walks source relationships has
 * not looked at them. Its walk classifies graph relationships into role scopes, so the citation
 * scope would take the no-contribution branch and be sealed as a proved zero over a population
 * nobody read. It stays out, and the support reading asks the citation records directly instead.
 */
export const NODE_SUPPORT_ROLE_SCOPES: readonly string[] = SUPPORT_ROLES.map((role) =>
  nodeRoleScope(role),
);

export type NodeSupportReading = {
  readonly support: NodeSupport;
  /** Why, in one phrase, so a blocked repair can say what it is waiting for. */
  readonly reason: string;
  /**
   * The scope tokens this reading rests on. A qualification recorded against it is void as soon
   * as any of them moves, whether the movement added support or removed it.
   */
  readonly evidenceRevision: Readonly<Record<string, string>>;
};

/**
 * What the committed records say about one node, with the tokens the answer rests on.
 *
 * A node with committed incidence in any support role is supported outright. A node with none is
 * unsupported only when every one of those ROLE scopes carries an established census and no
 * published revision cites it; a single uncounted role makes the whole answer unknown, because the
 * missing count is exactly where the support would have been recorded.
 */
/**
 * What the GRAPH says this node is, read from an authoritative label by the caller that has one.
 *
 * The records cannot answer it. A narrative the manifest never bound looks exactly like a claim
 * nobody ever recorded evidence for, and the two want opposite verdicts: the claim is genuinely
 * unsupported, and the narrative is a compressed account of history these tables were never asked
 * about. Blanket-protecting every unbound id would stop the ordinary repair; the classification is
 * what tells them apart, and it comes from whoever read the node.
 *
 * Omitted, the answer is the records' alone — which is right for a caller reasoning about an id
 * rather than about a node it has just read.
 */
export type NodeClassification = {
  /** The graph carries the `Narrative` label on this node. */
  readonly narrative: boolean;
};

export function certifyNodeSupport(
  db: SqliteHandle,
  nodeId: string,
  classification?: NodeClassification,
): NodeSupportReading {
  const evidenceRevision: Record<string, string> = {};
  for (const scope of NODE_SUPPORT_SCOPES) {
    evidenceRevision[scope] =
      publishedScopeToken(db, { endpointId: nodeId, relationClass: scope }) ?? 'absent';
  }
  for (const role of SUPPORT_ROLES) {
    if (countCommittedIncidenceForNode(db, nodeId, role) > 0) {
      return { support: 'supported', reason: `committed ${role} incidence`, evidenceRevision };
    }
  }
  // The stated population, read where the acceptance writer actually records it. A confirmation,
  // a correction or a derivation lands as a link version chain rather than an incidence row, and
  // a reading that asked only the incidence table would call a node nobody has counted anything
  // about the same as a node somebody has just confirmed.
  if (countCommittedStatedLinksTo(db, nodeId, STATED_SUPPORT_KINDS) > 0) {
    return { support: 'supported', reason: 'a committed statement names it', evidenceRevision };
  }
  // Every revision that ever published citing it, not only the one the family serves now. A
  // superseded revision still rested on this node and the lineage walk still crosses to it, and
  // what this reading authorizes is a suppression and then a forget with no reopen path, so it
  // reads the wider population on purpose.
  if (countCitationsTo(db, nodeId) > 0) {
    return {
      support: 'supported',
      reason: 'cited by a published narrative revision',
      evidenceRevision,
    };
  }
  // The node may BE a narrative revision rather than a target of one. Nothing above can see that:
  // a chunk's narrative is produced by no source and named by no statement, so every source-side
  // census over it is established and empty by construction, and a reading that stopped here
  // would certify the one record of what an evicted session said as holding nothing up. What
  // holds a narrative up is its frozen membership and its citations, which is what C3's predicate
  // asks. An id the manifest does not bind is not answered here, because that is silence.
  const narrative = certifyNarrativeSupport(db, nodeId);
  if (narrative.support === 'supported') {
    return {
      support: 'supported',
      reason: `a published narrative revision: ${narrative.reason}`,
      evidenceRevision,
    };
  }
  if (narrative.support === 'unknown') {
    return {
      support: 'unknown',
      reason: `a narrative revision the manifest cannot account for: ${narrative.reason}`,
      evidenceRevision,
    };
  }
  // A narrative the manifest binds nothing to. Its own family's records say nothing about it,
  // which for a narrative is silence rather than absence: the sources it compressed may have been
  // evicted, forgotten or never recorded here at all, and the account of them is the node itself.
  // The generic scopes below can be established and empty over it by construction — nothing is
  // extracted from a narrative and nothing is mentioned in one — so letting them settle the
  // question would mature the one record of a session toward suppression on an empty census.
  if (classification?.narrative === true) {
    return {
      support: 'unknown',
      reason: 'a narrative the manifest binds no revision to; its history is not in these records',
      evidenceRevision,
    };
  }

  const uncounted = SUPPORT_ROLES.filter(
    (role) =>
      !scopeSupportsVerifiedEmpty(db, { endpointId: nodeId, relationClass: nodeRoleScope(role) }),
  );
  if (uncounted.length > 0) {
    return {
      support: 'unknown',
      reason: `no established census for ${uncounted.join(', ')}`,
      evidenceRevision,
    };
  }
  // The citation population carries no census requirement, and that is deliberate. The scope is
  // filed per endpoint, and on a node that is a citation TARGET no producer establishes it: a
  // narrative publication counts only the set it authored on its own node, and the cohort seal
  // walks source relationships and has never read the revision records. Requiring it here asked
  // for a count nothing writes, so every ordinary node answered unknown for good and the repair
  // lifecycle was inert by construction rather than by policy. What answers the question is the
  // citation records read above: a revision records what it cited in the transaction that
  // acknowledges it. The token stays on the reading, so a qualification breaks when that
  // population moves.
  return {
    support: 'unsupported',
    reason: 'every support census is established and empty, and no revision ever cited it',
    evidenceRevision,
  };
}
