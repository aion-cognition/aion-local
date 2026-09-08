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
