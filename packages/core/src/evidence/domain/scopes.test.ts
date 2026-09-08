import { describe, expect, it } from 'vitest';

import {
  durableRoleScope,
  GRAPH_NODE_SCOPE,
  isRegisteredScope,
  registeredScopes,
  retainedRoleScope,
  scopeAuthority,
  DURABLE_ROLES,
  RETAINED_ROLES,
} from './scopes.js';

describe('the scope registry', () => {
  it('spells a role scope with its authority and direction', () => {
    expect(durableRoleScope('extraction', 'out')).toBe('sqlite:extraction:out');
    expect(retainedRoleScope('supersession', 'in')).toBe('graph:supersession:in');
  });

  it('keeps the two directions of one role apart', () => {
    expect(durableRoleScope('mention', 'in')).not.toBe(durableRoleScope('mention', 'out'));
  });

  it('refuses a role the relationship catalog does not classify', () => {
    expect(() => retainedRoleScope('invented_relation', 'out')).toThrow(/relationship catalog/);
  });

  it('admits the fixed scopes and rejects free-form text', () => {
    expect(isRegisteredScope('source.content')).toBe(true);
    expect(isRegisteredScope('sqlite.revision_citations')).toBe(true);
    expect(isRegisteredScope(GRAPH_NODE_SCOPE)).toBe(true);
    expect(isRegisteredScope('whatever.the.writer.felt.like')).toBe(false);
    expect(isRegisteredScope('sqlite:extraction:sideways')).toBe(false);
    expect(isRegisteredScope('graph:extraction:out')).toBe(false);
  });

  it('reads the authority off the scope name rather than off the endpoint', () => {
    expect(scopeAuthority('source.state')).toBe('sqlite');
    expect(scopeAuthority(durableRoleScope('raw_order', 'in'))).toBe('sqlite');
    expect(scopeAuthority(GRAPH_NODE_SCOPE)).toBe('graph');
    expect(scopeAuthority(retainedRoleScope('contradiction', 'out'))).toBe('graph');
    expect(() => scopeAuthority('not.a.scope')).toThrow(/registry/);
  });

  it('enumerates both directions of every role it admits', () => {
    const names = registeredScopes();

    expect(names).toContain('source.references');
    expect(names.filter((name) => name.startsWith('sqlite:'))).toHaveLength(
      DURABLE_ROLES.length * 2,
    );
    expect(names.filter((name) => name.startsWith('graph:'))).toHaveLength(
      new Set(RETAINED_ROLES).size * 2,
    );
  });
});
