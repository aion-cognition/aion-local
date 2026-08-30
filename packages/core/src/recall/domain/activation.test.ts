import { describe, expect, it, vi } from 'vitest';

import {
  edgeWeight,
  hubInhibition,
  spreadActivation,
  SUPERSEDED_ACTIVATION_WEIGHT,
  type ActivationBudget,
  type ActivationRun,
  type AdjacencyFetch,
} from './activation.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import type { AdjacencyNeighbor } from '../../infrastructure/graph/adjacency.js';
import type { CurrencyAnnotation } from '../../infrastructure/graph/read-modes.js';

type FixtureEdge = {
  readonly from: string;
  readonly to: string;
  readonly type: string;
  readonly strength?: number;
  readonly confidence?: number;
};

type Fixture = {
  readonly edges: readonly FixtureEdge[];
  /** Node id to the id of the node that superseded it. */
  readonly superseded?: Readonly<Record<string, string>>;
  /** Overrides the degree the fixture would otherwise derive, for hub cases. */
  readonly degrees?: Readonly<Record<string, number>>;
  readonly structural?: readonly string[];
};

type FetchRequest = {
  readonly frontier: readonly string[];
  readonly visited: readonly string[];
};

const SUPERSEDED_AT = new Date('2026-04-01T00:00:00.000Z');

const BASE_BUDGET: ActivationBudget = {
  maxIterations: 100,
  decayFactor: 0.7,
  minActivation: 0.1,
  maxNodesVisited: 500,
  hubThreshold: 10,
  maxHops: 2,
  associationStrength: 0.5,
  maxActivated: 50,
};

function withBudget(overrides: Partial<ActivationBudget>): ActivationBudget {
  return { ...BASE_BUDGET, ...overrides };
}

function degreeOf(fixture: Fixture, nodeId: string): number {
  const override = fixture.degrees?.[nodeId];
  if (override !== undefined) {
    return override;
  }
  return fixture.edges.filter((edge) => edge.from === nodeId || edge.to === nodeId).length;
}

function annotationFor(fixture: Fixture, nodeId: string): CurrencyAnnotation {
  const supersededBy = fixture.superseded?.[nodeId];
  if (supersededBy === undefined) {
    return { currency: 'current' };
  }
  return { currency: 'superseded', supersededBy: { id: supersededBy, at: SUPERSEDED_AT } };
}

/**
 * Stands in for `graph/adjacency.ts` on the same contract its Cypher implements: edges are
 * undirected, the frontier node itself is never returned, and visited ids are excluded.
 */
function neighborsFor(fixture: Fixture, request: FetchRequest): AdjacencyNeighbor[] {
  const visited = new Set(request.visited);
  const rows: AdjacencyNeighbor[] = [];

  for (const sourceId of request.frontier) {
    for (const edge of fixture.edges) {
      let nodeId: string | undefined;
      if (edge.from === sourceId) {
        nodeId = edge.to;
      } else if (edge.to === sourceId) {
        nodeId = edge.from;
      }
      if (nodeId === undefined || nodeId === sourceId || visited.has(nodeId)) {
        continue;
      }
      rows.push({
        sourceId,
        nodeId,
        relationshipType: edge.type,
        strength: edge.strength ?? 1,
        confidence: edge.confidence ?? 1,
        degree: degreeOf(fixture, nodeId),
        currency: annotationFor(fixture, nodeId),
        isStructural: fixture.structural?.includes(nodeId) === true,
      });
    }
  }

  return rows;
}

function fetchOver(fixture: Fixture): AdjacencyFetch {
  return (request) => Promise.resolve(neighborsFor(fixture, request));
}

function scoreOf(run: ActivationRun, nodeId: string): number {
  return run.activated.find((node) => node.nodeId === nodeId)?.score ?? 0;
}

describe('edgeWeight', () => {
  it('gives containment and provenance more of the source node’s relevance than a mention', () => {
    const participates = edgeWeight(neighbor({ relationshipType: 'PARTICIPATES_IN' }));
    const summarized = edgeWeight(neighbor({ relationshipType: 'SUMMARIZED_BY' }));
    const mentions = edgeWeight(neighbor({ relationshipType: 'MENTIONS' }));

    expect(participates).toBe(0.9);
    expect(summarized).toBe(0.9);
    expect(mentions).toBe(0.5);
    expect(mentions).toBeLessThan(participates);
  });

  it('scales SIMILAR and RELATED_TO by strength × confidence', () => {
    // SIMILAR's base weight carries MODEL_INFERRED_PENALTY (0.6 tuned x 0.5 discount = 0.3).
    expect(
      edgeWeight(neighbor({ relationshipType: 'SIMILAR', strength: 0.5, confidence: 0.5 })),
    ).toBeCloseTo(0.075, 10);
    expect(
      edgeWeight(neighbor({ relationshipType: 'RELATED_TO', strength: 0.4, confidence: 0.5 })),
    ).toBeCloseTo(0.1, 10);
    expect(edgeWeight(neighbor({ relationshipType: 'SIMILAR', strength: 1, confidence: 1 }))).toBe(
      0.3,
    );
  });

  it('halves CAUSES, ENABLES, PRECEDES, CONTRADICTS, and SIMILAR pending a precision-cleared harness', () => {
    expect(edgeWeight(neighbor({ relationshipType: 'CAUSES' }))).toBeCloseTo(0.35, 10);
    expect(edgeWeight(neighbor({ relationshipType: 'ENABLES' }))).toBeCloseTo(0.3, 10);
    expect(edgeWeight(neighbor({ relationshipType: 'PRECEDES' }))).toBeCloseTo(0.3, 10);
    expect(edgeWeight(neighbor({ relationshipType: 'CONTRADICTS' }))).toBeCloseTo(0.35, 10);
  });

  it('scales every other type by strength alone, ignoring confidence', () => {
    expect(
      edgeWeight(neighbor({ relationshipType: 'CO_OCCURS', strength: 0.1, confidence: 0.1 })),
    ).toBeCloseTo(0.05, 10);
    expect(
      edgeWeight(neighbor({ relationshipType: 'FOLLOWS', strength: 0.2, confidence: 0.2 })),
    ).toBeCloseTo(0.16, 10);
    expect(
      edgeWeight(neighbor({ relationshipType: 'CO_OCCURS', strength: 1, confidence: 0.1 })),
    ).toBe(0.5);
    expect(
      edgeWeight(neighbor({ relationshipType: 'FOLLOWS', strength: 1, confidence: 0.2 })),
    ).toBe(0.8);
  });

  it('falls back to the default weight for a type outside the catalog', () => {
    expect(edgeWeight(neighbor({ relationshipType: 'NOT_A_CATALOG_TYPE' }))).toBe(0.3);
  });
});

describe('hubInhibition', () => {
  it('applies no penalty up to the threshold and is continuous at it', () => {
    expect(hubInhibition(1, 10)).toBe(1);
    expect(hubInhibition(10, 10)).toBe(1);
    expect(hubInhibition(11, 10)).toBeLessThan(1);
    expect(hubInhibition(11, 10)).toBeCloseTo(1 / (1 + 0.5 * Math.log(2)), 10);
  });

  it('penalises in proportion to connectivity without ever severing the edge', () => {
    const modest = hubInhibition(20, 10);
    const heavy = hubInhibition(200, 10);
    expect(heavy).toBeLessThan(modest);
    expect(heavy).toBeGreaterThan(0);
  });
});

describe('spreadActivation', () => {
  it('returns seeds at full activation, at zero hops, with their id as the path', async () => {
    const run = await spreadActivation(fetchOver({ edges: [] }), {
      seeds: [{ nodeId: 'seed-a' }],
      budget: BASE_BUDGET,
    });

    expect(run.activated).toEqual([
      {
        nodeId: 'seed-a',
        score: 1,
        hops: 0,
        pathSummary: 'seed-a',
        currency: { currency: 'current' },
        isStructural: false,
      },
    ]);
    expect(run.termination).toBe('frontier_exhausted');
  });

  it('propagates activation as A × w_edge × decay', async () => {
    const run = await spreadActivation(
      fetchOver({ edges: [{ from: 'episode', to: 'session', type: 'PARTICIPATES_IN' }] }),
      { seeds: [{ nodeId: 'episode' }], budget: withBudget({ maxHops: 1 }) },
    );

    expect(scoreOf(run, 'session')).toBeCloseTo(0.9 * 0.7, 10);
    expect(run.activated.find((node) => node.nodeId === 'session')?.hops).toBe(1);
  });

  it('accumulates activation arriving from several paths', async () => {
    const onePath: FixtureEdge = { from: 'seed-a', to: 'shared', type: 'PARTICIPATES_IN' };
    const budget = withBudget({ maxHops: 1 });

    const twoPaths = await spreadActivation(
      fetchOver({ edges: [onePath, { from: 'seed-b', to: 'shared', type: 'PARTICIPATES_IN' }] }),
      { seeds: [{ nodeId: 'seed-a' }, { nodeId: 'seed-b' }], budget },
    );
    const onlyPath = await spreadActivation(fetchOver({ edges: [onePath] }), {
      seeds: [{ nodeId: 'seed-a' }],
      budget,
    });

    expect(scoreOf(onlyPath, 'shared')).toBeCloseTo(0.9 * 0.7, 10);
    expect(scoreOf(twoPaths, 'shared')).toBeCloseTo(scoreOf(onlyPath, 'shared') * 2, 10);
  });

  it('counts an edge between two nodes of the same frontier ring, once, in selection order', async () => {
    // Both seeds expand in one batch. One-at-a-time expansion visits one node at a time, so
    // the peer still in the frontier receives activation and does not send it back.
    const run = await spreadActivation(
      fetchOver({ edges: [{ from: 'seed-a', to: 'seed-b', type: 'PARTICIPATES_IN' }] }),
      { seeds: [{ nodeId: 'seed-a' }, { nodeId: 'seed-b' }], budget: withBudget({ maxHops: 1 }) },
    );

    expect(scoreOf(run, 'seed-a')).toBe(1);
    expect(scoreOf(run, 'seed-b')).toBeCloseTo(1 + 0.9 * 0.7, 10);
  });

  it('carries a decayed edge at the weight floor under the shipped cutoff', async () => {
    const fixture: Fixture = {
      edges: [
        { from: 'seed', to: 'faded', type: 'MENTIONS', strength: DEFAULTS.hebbian.weightFloor },
      ],
    };

    const run = await spreadActivation(fetchOver(fixture), {
      seeds: [{ nodeId: 'seed' }],
      budget: withBudget({
        maxHops: 1,
        associationStrength: DEFAULTS.recall.associationStrength,
        minActivation: 0,
      }),
    });

    expect(run.activated.map((node) => node.nodeId)).toContain('faded');
  });

  it('propagates a weakened edge in proportion to what is left of it', async () => {
    async function scoreAtStrength(strength: number): Promise<number> {
      const run = await spreadActivation(
        fetchOver({ edges: [{ from: 'seed', to: 'reached', type: 'MENTIONS', strength }] }),
        {
          seeds: [{ nodeId: 'seed' }],
          budget: withBudget({
            maxHops: 1,
            associationStrength: DEFAULTS.recall.associationStrength,
            minActivation: 0,
          }),
        },
      );
      return scoreOf(run, 'reached');
    }

    const [full, half, floored] = await Promise.all([
      scoreAtStrength(1),
      scoreAtStrength(0.5),
      scoreAtStrength(DEFAULTS.hebbian.weightFloor),
    ]);

    expect(half).toBeCloseTo(full / 2, 10);
    expect(floored).toBeCloseTo(full * DEFAULTS.hebbian.weightFloor, 10);
    expect(floored).toBeGreaterThan(0);
  });

  it('does not traverse an association weaker than the strength floor', async () => {
    const fixture: Fixture = {
      edges: [
        { from: 'seed', to: 'faded', type: 'RELATED_TO', strength: 0.2 },
        { from: 'seed', to: 'held', type: 'RELATED_TO', strength: 0.9 },
      ],
    };

    const run = await spreadActivation(fetchOver(fixture), {
      seeds: [{ nodeId: 'seed' }],
      budget: withBudget({ maxHops: 1, associationStrength: 0.5 }),
    });

    expect(run.activated.map((node) => node.nodeId)).toEqual(['seed', 'held']);
  });

  it('cuts the activated set to the configured limit, keeping the strongest', async () => {
    const fixture: Fixture = {
      edges: [0, 1, 2, 3].map((index) => ({
        from: 'seed',
        to: `n${String(index)}`,
        type: index === 0 ? 'PARTICIPATES_IN' : 'MENTIONS',
      })),
    };

    const run = await spreadActivation(fetchOver(fixture), {
      seeds: [{ nodeId: 'seed' }],
      budget: withBudget({ maxHops: 1, maxActivated: 2 }),
    });

    expect(run.activated.map((node) => node.nodeId)).toEqual(['seed', 'n0']);
  });

  it('carries the structural flag off the adjacency read', async () => {
    const fixture: Fixture = {
      edges: [{ from: 'seed', to: 'member', type: 'INITIATED_BY' }],
      structural: ['member'],
    };

    const run = await spreadActivation(fetchOver(fixture), {
      seeds: [{ nodeId: 'seed' }],
      budget: withBudget({ maxHops: 1 }),
    });

    expect(run.activated.find((node) => node.nodeId === 'member')?.isStructural).toBe(true);
    expect(run.activated.find((node) => node.nodeId === 'seed')?.isStructural).toBe(false);
  });

  it('inhibits a hub in proportion to its connectivity', async () => {
    const fixture: Fixture = {
      edges: [{ from: 'seed', to: 'workspace', type: 'WITHIN_WORKSPACE' }],
      degrees: { workspace: 60 },
    };

    const run = await spreadActivation(fetchOver(fixture), {
      seeds: [{ nodeId: 'seed' }],
      budget: withBudget({ maxHops: 1 }),
    });

    const uninhibited = 0.7 * 0.7;
    expect(scoreOf(run, 'workspace')).toBeCloseTo(uninhibited * hubInhibition(60, 10), 10);
    expect(scoreOf(run, 'workspace')).toBeLessThan(uninhibited);
  });

  it('records the strongest contributing path, edge types included', async () => {
    const fixture: Fixture = {
      edges: [
        { from: 'episode', to: 'session-2', type: 'PARTICIPATES_IN' },
        { from: 'session-2', to: 'session-1', type: 'FOLLOWS' },
      ],
    };

    const run = await spreadActivation(fetchOver(fixture), {
      seeds: [{ nodeId: 'episode' }],
      budget: BASE_BUDGET,
    });

    const reached = run.activated.find((node) => node.nodeId === 'session-1');
    expect(reached?.pathSummary).toBe(
      'episode -[PARTICIPATES_IN]-> session-2 -[FOLLOWS]-> session-1',
    );
    expect(reached?.hops).toBe(2);
  });

  it('reads the whole frontier in one fetch per iteration', async () => {
    const fixture: Fixture = {
      edges: [
        { from: 'seed-a', to: 'mid', type: 'PARTICIPATES_IN' },
        { from: 'seed-b', to: 'mid', type: 'PARTICIPATES_IN' },
        { from: 'seed-c', to: 'mid', type: 'PARTICIPATES_IN' },
        { from: 'mid', to: 'far', type: 'FOLLOWS' },
      ],
    };
    const fetch = vi.fn<AdjacencyFetch>((request) =>
      Promise.resolve(neighborsFor(fixture, request)),
    );

    const run = await spreadActivation(fetch, {
      seeds: [{ nodeId: 'seed-a' }, { nodeId: 'seed-b' }, { nodeId: 'seed-c' }],
      budget: BASE_BUDGET,
    });

    expect(run.iterations).toBe(2);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect([...(fetch.mock.calls[0]?.[0].frontier ?? [])].sort()).toEqual([
      'seed-a',
      'seed-b',
      'seed-c',
    ]);
    expect(fetch.mock.calls[1]?.[0].frontier).toEqual(['mid']);
    expect(fetch.mock.calls[1]?.[0].visited).toContain('seed-a');
  });
});

describe('spreadActivation superseded handling', () => {
  const fixture: Fixture = {
    edges: [
      { from: 'seed', to: 'old-fact', type: 'PARTICIPATES_IN' },
      { from: 'old-fact', to: 'beyond', type: 'PARTICIPATES_IN' },
    ],
    superseded: { 'old-fact': 'new-fact' },
  };

  it('down-weights a superseded node without hiding it, and carries its lineage', async () => {
    const run = await spreadActivation(fetchOver(fixture), {
      seeds: [{ nodeId: 'seed' }],
      budget: BASE_BUDGET,
    });

    const superseded = run.activated.find((node) => node.nodeId === 'old-fact');
    expect(superseded?.score).toBeCloseTo(0.9 * 0.7 * SUPERSEDED_ACTIVATION_WEIGHT, 10);
    expect(superseded?.currency).toEqual({
      currency: 'superseded',
      supersededBy: { id: 'new-fact', at: SUPERSEDED_AT },
    });
  });

  it('keeps a superseded node traversable, so what lies beyond it still activates', async () => {
    const run = await spreadActivation(fetchOver(fixture), {
      seeds: [{ nodeId: 'seed' }],
      budget: BASE_BUDGET,
    });

    expect(scoreOf(run, 'beyond')).toBeCloseTo(
      0.9 * 0.7 * SUPERSEDED_ACTIVATION_WEIGHT * 0.9 * 0.7,
      10,
    );
  });

  it('starts a superseded seed at the down-weighted activation', async () => {
    const run = await spreadActivation(fetchOver({ edges: [] }), {
      seeds: [
        {
          nodeId: 'seed',
          currency: { currency: 'superseded', supersededBy: { id: 'newer', at: SUPERSEDED_AT } },
        },
      ],
      budget: BASE_BUDGET,
    });

    expect(scoreOf(run, 'seed')).toBe(SUPERSEDED_ACTIVATION_WEIGHT);
  });
});

describe('spreadActivation termination', () => {
  const chain: Fixture = {
    edges: [
      { from: 'n0', to: 'n1', type: 'PARTICIPATES_IN' },
      { from: 'n1', to: 'n2', type: 'PARTICIPATES_IN' },
      { from: 'n2', to: 'n3', type: 'PARTICIPATES_IN' },
      { from: 'n3', to: 'n4', type: 'PARTICIPATES_IN' },
    ],
  };

  it('stops when the frontier runs out', async () => {
    const run = await spreadActivation(fetchOver({ edges: [] }), {
      seeds: [{ nodeId: 'n0' }],
      budget: BASE_BUDGET,
    });

    expect(run.termination).toBe('frontier_exhausted');
    expect(run.iterations).toBe(1);
  });

  it('stops when no frontier node clears the minimum activation', async () => {
    const run = await spreadActivation(fetchOver(chain), {
      seeds: [{ nodeId: 'n0' }],
      budget: withBudget({ minActivation: 0.5, maxHops: 10 }),
    });

    expect(run.termination).toBe('below_min_activation');
    // n1 clears 0.5 at 0.63; n2 arrives at 0.3969 and is where the spread stops.
    expect(run.activated.map((node) => node.nodeId)).toEqual(['n0', 'n1']);
  });

  it('stops at the hop limit, leaving the last ring activated but unexpanded', async () => {
    const run = await spreadActivation(fetchOver(chain), {
      seeds: [{ nodeId: 'n0' }],
      budget: withBudget({ maxHops: 1, minActivation: 0.01 }),
    });

    expect(run.termination).toBe('hop_limit');
    expect(run.activated.map((node) => node.nodeId)).toEqual(['n0', 'n1']);
  });

  it('stops when the node budget is spent', async () => {
    const run = await spreadActivation(fetchOver(chain), {
      seeds: [{ nodeId: 'n0' }],
      budget: withBudget({ maxNodesVisited: 2, maxHops: 10, minActivation: 0.01 }),
    });

    expect(run.termination).toBe('node_budget');
    expect(run.nodesVisited).toBe(2);
    // Two nodes expanded, and the ring they reached still comes back activated.
    expect(run.activated.map((node) => node.nodeId)).toEqual(['n0', 'n1', 'n2']);
  });

  it('stops at the iteration ceiling', async () => {
    const run = await spreadActivation(fetchOver(chain), {
      seeds: [{ nodeId: 'n0' }],
      budget: withBudget({ maxIterations: 2, maxHops: 10, minActivation: 0.01 }),
    });

    expect(run.termination).toBe('max_iterations');
    expect(run.iterations).toBe(2);
    expect(run.nodesVisited).toBe(2);
  });
});

function neighbor(overrides: Partial<AdjacencyNeighbor>): AdjacencyNeighbor {
  return {
    sourceId: 'source',
    nodeId: 'target',
    relationshipType: 'PARTICIPATES_IN',
    strength: 1,
    confidence: 1,
    degree: 1,
    currency: { currency: 'current' },
    isStructural: false,
    ...overrides,
  };
}
