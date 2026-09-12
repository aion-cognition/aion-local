import { describe, expect, it } from 'vitest';

import { legacyCoverageScopes } from './legacy-coverage.js';
import { referenceScopeNames } from './reference-acceptance.js';
import {
  bothEndpoints,
  DURABLE_ROLES,
  nodeRoleScope,
  sourceRoleScope,
  type DurableRole,
} from '../../evidence/domain/scopes.js';
import { planScopes, type MaterializedLink } from '../domain/legacy-materialization.js';

/**
 * The writer-audit rule, held to by the writers rather than written down beside them.
 *
 * A writer that changes an incidence and advances only the reciprocal scope is nonconforming.
 * Nothing can enforce that with a repo scan: every direction is computed at runtime from the
 * role, so there is no column name or literal to match on. What can be enforced is that each
 * scope-set function returns BOTH counters for every role it touches, which is what this asks.
 *
 * The conformance audit at the time of writing found no nonconforming production writer. This
 * battery is what keeps that true through the next one.
 */

const SOURCE = 'source-1';
const NODE = 'node-1';

/** Both scopes of one role, as the rule states them, independent of who computed them. */
function expectedPair(role: DurableRole): readonly string[] {
  return [`${SOURCE}\n${sourceRoleScope(role)}`, `${NODE}\n${nodeRoleScope(role)}`].sort();
}

function keysOf(
  entries: readonly { readonly endpointId: string; readonly relationClass: string }[],
): readonly string[] {
  return entries.map((entry) => `${entry.endpointId}\n${entry.relationClass}`).sort();
}

function materialized(role: DurableRole): MaterializedLink {
  return {
    linkId: `link-${role}`,
    kind: role,
    qualifier: 'retained_node',
    fromId: SOURCE,
    toId: NODE,
    relationId: 'relation-1',
    relationType: 'MENTIONS',
    scopeRole: role,
    incident: true,
    closed: false,
    clocks: {},
    recorded: {},
  };
}

describe('the both-endpoints rule', () => {
  it('names the source and the node under opposite directions, for every role', () => {
    for (const role of DURABLE_ROLES) {
      const [source, node] = bothEndpoints(role, SOURCE, NODE);

      expect(source.endpointId).toBe(SOURCE);
      expect(node.endpointId).toBe(NODE);
      expect(source.relationClass).not.toBe(node.relationClass);
      expect(keysOf([source, node])).toEqual(expectedPair(role));
    }
  });

  it('puts the node on the side the registry files its census under', () => {
    // A mention is filed on the thing mentioned and an extraction on the claim that asserts it,
    // so the two roles put the node on opposite sides and the rule has to follow the role.
    expect(bothEndpoints('mention', SOURCE, NODE)[1].relationClass).toBe('sqlite:mention:in');
    expect(bothEndpoints('extraction', SOURCE, NODE)[1].relationClass).toBe(
      'sqlite:extraction:out',
    );
    expect(bothEndpoints('extraction', SOURCE, NODE)[0].relationClass).toBe('sqlite:extraction:in');
  });
});

describe('every scope-set writer advances both ends', () => {
  it('holds for the legacy coverage writer', () => {
    const scopes = legacyCoverageScopes({
      sourceIds: [SOURCE],
      nodeId: NODE,
      create: true,
      closed: [],
      observedAt: '2026-09-12T09:00:00.000Z',
      occurredAt: '2026-09-12T09:00:00.000Z',
    });

    expect(keysOf(scopes)).toEqual(expectedPair('source_coverage'));
  });

  it('holds for the legacy materialization plan, for every role it can carry', () => {
    for (const role of DURABLE_ROLES) {
      expect(keysOf(planScopes(SOURCE, [materialized(role)]))).toEqual(expectedPair(role));
    }
  });

  it('holds for the reference acceptance writer, on each stated kind', () => {
    const roleOf = {
      corrects: 'stated_correction',
      derived_from: 'stated_derivation',
      confirms: 'stated_confirmation',
    } as const;

    for (const [kind, role] of Object.entries(roleOf)) {
      const named = referenceScopeNames({
        sourceId: SOURCE,
        targets: [{ id: NODE, kind: kind as keyof typeof roleOf, targetClass: 'retained_node' }],
      });

      expect(named.map((entry) => `${entry.id}\n${entry.scope}`).sort()).toEqual(
        expectedPair(role),
      );
      // The declared kind follows the endpoint, so a reader can tell which counter is whose.
      expect(named.find((entry) => entry.id === SOURCE)?.kind).toBe('source');
      expect(named.find((entry) => entry.id === NODE)?.kind).toBe('node');
    }
  });

  it('declares nothing for a plan carrying no links, rather than one bare endpoint', () => {
    expect(planScopes(SOURCE, [])).toEqual([]);
  });
});
