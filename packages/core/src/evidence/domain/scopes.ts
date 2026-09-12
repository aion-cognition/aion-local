import { SEMANTIC_RELATIONSHIP_TYPES } from '../../infrastructure/graph/semantic-relationship-queries.js';

/**
 * The closed registry of scope names a dependency may cite.
 *
 * A dependency's identity is the whole tuple of kind, endpoint and scope, and the authority
 * prefix is part of the scope: a parent step that read both a retained relation and source
 * metadata records two dependencies, because no counter advances in two stores at once. A
 * free-form string is not a scope, so a name outside this registry is refused rather than
 * stored as text nobody can verify later.
 *
 * Role names extend only through the relationship catalog below. Adding a role is a compile-time
 * edit against that catalog, never a value a caller invents at runtime.
 */

/** SQLite owns raw identity, part addressing, suppression and committed reference state. */
export const SOURCE_SCOPES = [
  'source.content',
  'source.parts',
  'source.state',
  'source.references',
] as const;

/** The chain of statements about a source itself, which a historical question is proved against. */
export const SOURCE_STATE_SCOPE = 'source.state';

/** Neo4j owns retained interpretation identity, semantic properties, currency and eligibility. */
export const GRAPH_NODE_SCOPE = 'graph.node_state';

/** SQLite owns the narrative citation set, frozen membership, and session representation. */
export const NARRATIVE_SCOPES = [
  'sqlite.revision_citations',
  'sqlite.coverage_members',
  'sqlite.family_selection',
  'sqlite.session_sources',
] as const;

/** Incidence roles recorded beside the source records themselves. */
export const DURABLE_ROLES = [
  'raw_order',
  'session_ownership',
  'extraction',
  'mention',
  'participation',
  'stated_confirmation',
  'stated_correction',
  'stated_derivation',
  'source_coverage',
] as const;

/**
 * Roles between retained nodes. The classified semantic relations come from the relationship
 * catalog, so a role cannot name a relation the graph does not classify.
 */
export const RETAINED_ROLES = [
  'supersession',
  'contradiction',
  ...SEMANTIC_RELATIONSHIP_TYPES.map((type) => type.toLowerCase()),
] as const satisfies readonly string[];

export type SourceScope = (typeof SOURCE_SCOPES)[number];
export type NarrativeScope = (typeof NARRATIVE_SCOPES)[number];
export type DurableRole = (typeof DURABLE_ROLES)[number];
export type ScopeDirection = 'in' | 'out';

const RETAINED_ROLE_SET = new Set<string>(RETAINED_ROLES);

/** Which store advances this scope's counter, and therefore which store proves it current. */
export type ScopeAuthority = 'sqlite' | 'graph';

export function durableRoleScope(role: DurableRole, direction: ScopeDirection): string {
  return `sqlite:${role}:${direction}`;
}

/**
 * Which end of a durable role the NODE sits on.
 *
 * An incidence link is always stored source-to-node, and the scope direction is a separate
 * question the registry answers: a claim's own extraction is `extraction:out` on the claim,
 * because the claim is the end that asserts it, while a mention is `mention:in` on the thing
 * mentioned. Deriving the direction from how the link happens to be stored would file a claim's
 * extraction under a counter nothing else reads.
 */
const NODE_DIRECTION: Readonly<Record<DurableRole, ScopeDirection>> = {
  extraction: 'out',
  mention: 'in',
  participation: 'in',
  source_coverage: 'in',
  session_ownership: 'in',
  raw_order: 'in',
  stated_confirmation: 'in',
  stated_correction: 'in',
  stated_derivation: 'in',
};

export function nodeScopeDirection(role: DurableRole): ScopeDirection {
  return NODE_DIRECTION[role];
}

/** The other end of the same role. The source always sits opposite the node. */
export function sourceScopeDirection(role: DurableRole): ScopeDirection {
  return NODE_DIRECTION[role] === 'in' ? 'out' : 'in';
}

/** The scope a node's census for this role is filed under. */
export function nodeRoleScope(role: DurableRole): string {
  return durableRoleScope(role, nodeScopeDirection(role));
}

/** The scope a source's census for this role is filed under. */
export function sourceRoleScope(role: DurableRole): string {
  return durableRoleScope(role, sourceScopeDirection(role));
}

/** One endpoint's counter, named: which endpoint, and the scope its census is filed under. */
export type EndpointScope = {
  readonly endpointId: string;
  readonly relationClass: string;
};

/**
 * BOTH counters a writer changing this incidence has to advance, in a fixed order.
 *
 * A writer that changes an incidence and advances only the reciprocal scope is nonconforming:
 * the node's census and the source's census are two different counters answering two different
 * questions, and a reader asking the one that did not move is told nothing changed. The rule was
 * written down and every writer implemented it separately, by computing the opposite direction
 * inline; five copies of that computation is five chances to keep one and drop the other.
 *
 * This is the rule as a value rather than as a habit. There is nothing to enforce with a scan —
 * the direction is computed at runtime and no column name gives it away — so the enforcement is
 * that writers call this and a battery holds it to the pair.
 */
export function bothEndpoints(
  role: DurableRole,
  sourceId: string,
  nodeId: string,
): readonly [EndpointScope, EndpointScope] {
  return [
    { endpointId: sourceId, relationClass: sourceRoleScope(role) },
    { endpointId: nodeId, relationClass: nodeRoleScope(role) },
  ];
}

export function retainedRoleScope(role: string, direction: ScopeDirection): string {
  if (!RETAINED_ROLE_SET.has(role)) {
    throw new Error(`retained role ${role} is not in the relationship catalog`);
  }
  return `graph:${role}:${direction}`;
}

const FIXED_SCOPES = new Set<string>([...SOURCE_SCOPES, GRAPH_NODE_SCOPE, ...NARRATIVE_SCOPES]);

function roleScopeParts(scope: string): readonly [string, string, string] | undefined {
  const parts = scope.split(':');
  if (parts.length !== 3) {
    return undefined;
  }
  const [prefix, role, direction] = parts as [string, string, string];
  if ((prefix !== 'sqlite' && prefix !== 'graph') || (direction !== 'in' && direction !== 'out')) {
    return undefined;
  }
  return [prefix, role, direction];
}

export function isRegisteredScope(scope: string): boolean {
  if (FIXED_SCOPES.has(scope)) {
    return true;
  }
  const parts = roleScopeParts(scope);
  if (parts === undefined) {
    return false;
  }
  const [prefix, role] = parts;
  return prefix === 'sqlite'
    ? (DURABLE_ROLES as readonly string[]).includes(role)
    : RETAINED_ROLE_SET.has(role);
}

/**
 * Which store to ask for this scope's current version. A graph-authority scope is never read
 * from a SQLite counter: the copy there records what the graph said at some moment, and only
 * the publication checkpoint certifies that it still says it.
 */
export function scopeAuthority(scope: string): ScopeAuthority {
  if (!isRegisteredScope(scope)) {
    throw new Error(`scope ${scope} is not in the registry`);
  }
  if (scope === GRAPH_NODE_SCOPE) {
    return 'graph';
  }
  return roleScopeParts(scope)?.[0] === 'graph' ? 'graph' : 'sqlite';
}

/** Every scope name the registry currently admits, for a caller enumerating the closed set. */
export function registeredScopes(): readonly string[] {
  const roles = DURABLE_ROLES.flatMap((role) => [
    durableRoleScope(role, 'in'),
    durableRoleScope(role, 'out'),
  ]);
  const retained = [...RETAINED_ROLE_SET].flatMap((role) => [
    retainedRoleScope(role, 'in'),
    retainedRoleScope(role, 'out'),
  ]);
  return [...FIXED_SCOPES, ...roles, ...retained];
}
