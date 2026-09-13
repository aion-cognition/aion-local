import { describe, expect, it } from 'vitest';

import { ACTIVATION_WEIGHTS } from './activation-weights.js';
import { edgeWeight } from './activation.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import type { AdjacencyNeighbor } from '../../infrastructure/graph/adjacency.js';

/**
 * The prerequisite the co-occurrence density weighting rests on: traversal reads an edge's own
 * strength rather than a flat weight for its type. Without it, weighting a birth changes what is
 * stored and nothing about what recall does with it.
 *
 * These are controls, not a change. They stand so a later edit that made CO_OCCURS propagate a
 * fixed share fails here rather than quietly making the density weighting inert.
 */

function neighbor(strength: number): AdjacencyNeighbor {
  return {
    sourceId: 'seed',
    nodeId: 'other',
    relationshipType: 'CO_OCCURS',
    strength,
    confidence: 1,
    degree: 2,
    isStructural: false,
    currency: { currency: 'current' },
  };
}

describe('co-occurrence traversal', () => {
  it('scales propagation by the edge strength the birth weighting wrote', () => {
    const strong = edgeWeight(neighbor(1));
    const weak = edgeWeight(neighbor(0.1));

    expect(strong).toBeCloseTo(ACTIVATION_WEIGHTS.CO_OCCURS, 10);
    expect(weak).toBeCloseTo(ACTIVATION_WEIGHTS.CO_OCCURS * 0.1, 10);
    expect(weak).toBeLessThan(strong);
  });

  it('carries a positive contribution through an edge born at the floor', () => {
    expect(edgeWeight(neighbor(DEFAULTS.hebbian.weightFloor))).toBeGreaterThan(0);
  });

  /**
   * What a weak-born edge can and cannot do, in the numbers the shipped knobs set.
   *
   * A seed's own score is fixed by nomination, so one hop from a full-score seed through a
   * floor-strength CO_OCCURS edge arrives under `minActivation` and the far node does not
   * surface on that path alone. A stronger semantic match on the seed does not raise it, since
   * the seed score is not the cosine. What raises it is support arriving from more than one
   * path, which is what repetition and the rest of the neighbourhood supply.
   */
  it('does not promise that one floor-strength hop surfaces a node on its own', () => {
    const arriving =
      1 * DEFAULTS.activation.decayFactor * edgeWeight(neighbor(DEFAULTS.hebbian.weightFloor));

    expect(arriving).toBeGreaterThan(0);
    expect(arriving).toBeLessThan(DEFAULTS.activation.minActivation);
  });

  it('surfaces the same node once enough paths through weak edges accumulate on it', () => {
    const perPath =
      1 * DEFAULTS.activation.decayFactor * edgeWeight(neighbor(DEFAULTS.hebbian.weightFloor));
    const paths = Math.ceil(DEFAULTS.activation.minActivation / perPath);

    expect(perPath * paths).toBeGreaterThanOrEqual(DEFAULTS.activation.minActivation);
    expect(paths).toBeLessThanOrEqual(DEFAULTS.recall.adjacencyTopK);
  });
});
