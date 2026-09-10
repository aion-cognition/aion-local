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
import { readCitationsOf } from '../../infrastructure/sqlite/narrative-citations.js';
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
 * looking established.
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
 * The citation population is the revision records C2 owns. A pass that walks source relationships
 * has not looked at them and cannot prove a legacy graph citation is represented among them, so it
 * counts what it walked and leaves that scope unknown — which keeps the support answer unknown
 * too, honestly, until whoever owns those records counts them.
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
 * unsupported only when every one of those scopes carries an established census and no narrative
 * cites it; a single uncounted scope makes the whole answer unknown, because the missing count is
 * exactly where the support would have been recorded.
 */
export function certifyNodeSupport(db: SqliteHandle, nodeId: string): NodeSupportReading {
  const evidenceRevision: Record<string, string> = {};
  for (const scope of NODE_SUPPORT_SCOPES) {
    evidenceRevision[scope] =
      publishedScopeToken(db, { endpointId: nodeId, relationClass: scope }) ?? 'absent';
  }
  const citationScope = NARRATIVE_SCOPES[0];

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
  if (readCitationsOf(db, nodeId).length > 0) {
    return { support: 'supported', reason: 'cited by a narrative revision', evidenceRevision };
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
  if (!scopeSupportsVerifiedEmpty(db, { endpointId: nodeId, relationClass: citationScope })) {
    return {
      support: 'unknown',
      reason: `no established census for ${citationScope}`,
      evidenceRevision,
    };
  }
  return {
    support: 'unsupported',
    reason: 'every support census is established and empty',
    evidenceRevision,
  };
}
