import { describe, expect, it } from 'vitest';
import { buildEdgeWeightReinforcement } from './edge-weights.js';
import { GraphWriteError } from './errors.js';
import { BASE_NODE_LABEL } from './labels.js';
import { PROTECTED_RELATIONSHIP_TYPES } from './protected-relationships.js';

const PAIRS = [{ sourceId: 'a', targetId: 'b', learningRate: 0.1 }];

describe('bounded edge weight reinforcement', () => {
  it('resolves both endpoints through the indexed base label', () => {
    const { cypher } = buildEdgeWeightReinforcement({ pairs: PAIRS, weightFloor: 0.1 });
    expect(cypher).toContain(
      `MATCH (a:${BASE_NODE_LABEL} { id: pair.sourceId })-[r]-(b:${BASE_NODE_LABEL} { id: pair.targetId })`,
    );
  });

  it('applies the bounded rule as one read-and-write statement', () => {
    const { cypher } = buildEdgeWeightReinforcement({ pairs: PAIRS, weightFloor: 0.1 });
    expect(cypher).toContain('WITH r, w + eta * (1.0 - w) AS raw');
    expect(cypher).toContain('WHEN raw > 1.0 THEN 1.0');
    expect(cypher).toContain('WHEN raw < $weightFloor THEN $weightFloor');
  });

  it('excludes the protected types by parameter rather than by query text', () => {
    const { cypher, parameters } = buildEdgeWeightReinforcement({ pairs: PAIRS, weightFloor: 0.1 });
    expect(cypher).toContain('WHERE NOT type(r) IN $protected');
    expect(parameters['protected']).toEqual([...PROTECTED_RELATIONSHIP_TYPES]);
  });

  it('skips an edge onto a forgotten node at either end', () => {
    const { cypher } = buildEdgeWeightReinforcement({ pairs: PAIRS, weightFloor: 0.1 });
    expect(cypher).toContain('a.forgotten_at IS NULL');
    expect(cypher).toContain('b.forgotten_at IS NULL');
  });

  it('refreshes updated_at and writes no other edge property', () => {
    const { cypher } = buildEdgeWeightReinforcement({ pairs: PAIRS, weightFloor: 0.1 });
    expect(cypher).toContain('r.updated_at = $now');
    expect(cypher).not.toContain('r.count');
    expect(cypher).not.toContain('r.confidence');
    expect(cypher).not.toContain('r.created_at');
  });

  it('carries one parameter entry per pair', () => {
    const { parameters } = buildEdgeWeightReinforcement({
      pairs: [
        { sourceId: 'a', targetId: 'b', learningRate: 0.1 },
        { sourceId: 'c', targetId: 'd', learningRate: 0.03 },
      ],
      weightFloor: 0.1,
    });
    expect(parameters['pairs']).toEqual([
      { sourceId: 'a', targetId: 'b', learningRate: 0.1 },
      { sourceId: 'c', targetId: 'd', learningRate: 0.03 },
    ]);
  });

  it('rejects a learning rate outside zero to one', () => {
    expect(() =>
      buildEdgeWeightReinforcement({
        pairs: [{ sourceId: 'a', targetId: 'b', learningRate: 1.5 }],
        weightFloor: 0.1,
      }),
    ).toThrow(GraphWriteError);
  });

  it('rejects a weight floor outside zero to one', () => {
    expect(() => buildEdgeWeightReinforcement({ pairs: PAIRS, weightFloor: 2 })).toThrow(
      GraphWriteError,
    );
  });

  it('rejects a pair missing an endpoint id', () => {
    expect(() =>
      buildEdgeWeightReinforcement({
        pairs: [{ sourceId: '', targetId: 'b', learningRate: 0.1 }],
        weightFloor: 0.1,
      }),
    ).toThrow(GraphWriteError);
  });
});
