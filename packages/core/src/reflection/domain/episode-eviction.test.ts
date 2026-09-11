import { describe, expect, it } from 'vitest';

import {
  classifyIncidentEdge,
  classifyRemovalSet,
  EVICTION_BOUNDS,
  preservedEdgeDigest,
  removalSetBound,
  type IncidentEdge,
} from './episode-eviction.js';

/**
 * The classifier decides what may be removed, so every case here is a case about refusing. The
 * three that are allowed are narrow and named; everything else has to come back blocked with a
 * reason, including the types the catalog knows and the endpoint combinations nobody classified.
 */

const EPISODE = 'episode-1';
const TURN = 'turn-1';

function edge(overrides: Partial<IncidentEdge> = {}): IncidentEdge {
  return {
    relationId: 'rel-1',
    type: 'PARTICIPATES_IN',
    fromId: TURN,
    toId: EPISODE,
    insideIds: [TURN, EPISODE],
    outsideLabels: [],
    provenance: ['reflection_intake'],
    properties: { strength: 1, created_at: '2026-09-01T00:00:00.000Z' },
    ...overrides,
  };
}

/**
 * Every node the registry names carries `AionNode`, so the fixture carries it too. An endpoint
 * without it is a different case with its own refusal, asserted below.
 */
function outward(type: string, labels: readonly string[]): IncidentEdge {
  return edge({
    type,
    fromId: EPISODE,
    toId: 'entity-1',
    insideIds: [EPISODE],
    outsideId: 'entity-1',
    outsideLabels: ['AionNode', ...labels],
  });
}

describe('classifyIncidentEdge', () => {
  it('calls the two shapes intake writes inside one source disposable backbone', () => {
    expect(classifyIncidentEdge(edge())).toEqual({ category: 'raw_backbone' });
    expect(
      classifyIncidentEdge(
        edge({ type: 'FOLLOWS', fromId: TURN, toId: 'turn-0', insideIds: [TURN, 'turn-0'] }),
      ),
    ).toEqual({ category: 'raw_backbone' });
  });

  it('blocks anything else written between two nodes of one projection', () => {
    expect(classifyIncidentEdge(edge({ type: 'MENTIONS' }))).toEqual({
      category: 'block',
      reason: 'unexpected_internal_mentions',
    });
  });

  it('treats episode ownership of a session as backbone and entity participation as evidence', () => {
    expect(classifyIncidentEdge(outward('PARTICIPATES_IN', ['Session']))).toEqual({
      category: 'raw_backbone',
    });
    expect(classifyIncidentEdge(outward('PARTICIPATES_IN', ['Entity', 'Memory']))).toEqual({
      category: 'preserved_evidence',
      role: 'participation',
      nodeId: 'entity-1',
    });
  });

  it('blocks a participation endpoint the taxonomy does not name', () => {
    expect(classifyIncidentEdge(outward('PARTICIPATES_IN', ['Insight']))).toEqual({
      category: 'block',
      reason: 'participation_endpoint_unclassified',
    });
  });

  it('names the durable role each preserved category has to be proved by', () => {
    const roles = [
      ['EXTRACTED_FROM', 'extraction'],
      ['MENTIONS', 'mention'],
      ['SUMMARIZED_BY', 'source_coverage'],
      ['EVIDENCES', 'stated_confirmation'],
      ['CORRECTS', 'stated_correction'],
      ['DERIVES_FROM', 'stated_derivation'],
    ] as const;
    for (const [type, role] of roles) {
      expect.soft(classifyIncidentEdge(outward(type, ['Entity']))).toEqual({
        category: 'preserved_evidence',
        role,
        nodeId: 'entity-1',
      });
    }
  });

  it('treats co-occurrence as disposable and names the survivor that owes a recomputation', () => {
    expect(classifyIncidentEdge(outward('CO_OCCURS', ['Entity']))).toEqual({
      category: 'disposable_association',
      survivorId: 'entity-1',
    });
  });

  it('refuses a similar edge rather than reading its type as permission', () => {
    expect(classifyIncidentEdge(outward('SIMILAR', ['Entity']))).toEqual({
      category: 'block',
      reason: 'unclassified_role_similar',
    });
  });

  it('blocks an order edge that leaves this source family', () => {
    expect(
      classifyIncidentEdge(
        edge({
          type: 'FOLLOWS',
          fromId: TURN,
          toId: 'turn-other',
          insideIds: [TURN],
          outsideId: 'turn-other',
          outsideLabels: ['AionNode', 'Turn', 'Memory'],
        }),
      ),
    ).toEqual({ category: 'block', reason: 'follows_crosses_source_family' });
  });

  it('blocks semantic state and structural wiring at a raw endpoint', () => {
    expect(classifyIncidentEdge(outward('SUPERSEDES', ['Insight']))).toEqual({
      category: 'block',
      reason: 'semantic_state_supersedes',
    });
    expect(classifyIncidentEdge(outward('CONTRADICTS', ['Insight']))).toEqual({
      category: 'block',
      reason: 'semantic_state_contradicts',
    });
    expect(classifyIncidentEdge(outward('INITIATED_BY', ['Member']))).toEqual({
      category: 'block',
      reason: 'structural_at_raw_endpoint_initiated_by',
    });
  });

  it('blocks an endpoint the node registry does not name, whatever the type is', () => {
    expect(
      classifyIncidentEdge(
        edge({
          type: 'MENTIONS',
          fromId: EPISODE,
          toId: 'admin-probe',
          insideIds: [EPISODE],
          outsideId: 'admin-probe',
          outsideLabels: ['AdminProbe'],
        }),
      ),
    ).toEqual({ category: 'block', reason: 'endpoint_outside_node_registry' });
  });

  it('blocks a type outside the catalog rather than inferring anything from its absence', () => {
    expect(classifyIncidentEdge(outward('INVENTED_BY', ['Entity']))).toEqual({
      category: 'block',
      reason: 'unknown_relationship_type',
    });
  });
});

describe('preservedEdgeDigest', () => {
  it('ignores exactly the access-only stamps', () => {
    const before = preservedEdgeDigest(
      edge({ properties: { strength: 1, access_count: 2, last_accessed_at: 'a' } }),
    );
    const after = preservedEdgeDigest(
      edge({ properties: { strength: 1, access_count: 900, last_accessed_at: 'b' } }),
    );
    expect(after).toBe(before);
  });

  it('moves when a preserved payload moves, plasticity weight included', () => {
    const before = preservedEdgeDigest(edge({ properties: { strength: 1 } }));
    expect(preservedEdgeDigest(edge({ properties: { strength: 0.5 } }))).not.toBe(before);
  });
});

describe('classifyRemovalSet', () => {
  it('stops at the first refusal and names the relationship that caused it', () => {
    const result = classifyRemovalSet([
      edge(),
      outward('SIMILAR', ['Entity']),
      outward('MENTIONS', ['Entity']),
    ]);
    expect(result).toEqual({
      status: 'blocked',
      reason: 'unclassified_role_similar',
      relationId: 'rel-1',
    });
  });

  it('refuses an edge carrying no identity of its own', () => {
    expect(classifyRemovalSet([edge({ relationId: '' })])).toMatchObject({
      status: 'blocked',
      reason: 'edge_identity_missing',
    });
  });

  it('collects the roles to prove and the survivors to recompute', () => {
    const result = classifyRemovalSet([
      edge(),
      { ...outward('MENTIONS', ['Entity']), relationId: 'rel-2' },
      {
        ...outward('CO_OCCURS', ['Entity']),
        relationId: 'rel-3',
        toId: 'entity-2',
        outsideId: 'entity-2',
      },
    ]);
    expect(result).toMatchObject({
      status: 'classified',
      required: [{ nodeId: 'entity-1', role: 'mention' }],
      survivorIds: ['entity-2'],
    });
  });

  it('gives a changed category a different digest from a changed payload', () => {
    const base = classifyRemovalSet([{ ...outward('MENTIONS', ['Entity']), relationId: 'rel-2' }]);
    const recategorized = classifyRemovalSet([
      { ...outward('CO_OCCURS', ['Entity']), relationId: 'rel-2' },
    ]);
    const repayloaded = classifyRemovalSet([
      { ...outward('MENTIONS', ['Entity']), relationId: 'rel-2', properties: { strength: 0.2 } },
    ]);
    expect(base.status).toBe('classified');
    if (base.status !== 'classified') {
      return;
    }
    for (const other of [recategorized, repayloaded]) {
      expect(other.status).toBe('classified');
      if (other.status === 'classified') {
        expect.soft(other.categoryDigest).not.toBe(base.categoryDigest);
      }
    }
  });
});

describe('removalSetBound', () => {
  it('admits one episode and its two hundred turns and refuses the next node', () => {
    expect(removalSetBound(EVICTION_BOUNDS.nodes, 0)).toBeUndefined();
    expect(removalSetBound(EVICTION_BOUNDS.nodes + 1, 0)).toBe('removal_set_nodes_bound');
  });

  it('refuses an incident set past its own bound', () => {
    expect(removalSetBound(1, EVICTION_BOUNDS.edges + 1)).toBe('removal_set_edges_bound');
  });
});
