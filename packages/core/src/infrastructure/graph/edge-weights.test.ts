import neo4j from 'neo4j-driver';
import { describe, expect, it } from 'vitest';
import { buildEdgeWeightDecay, buildEdgeWeightReinforcement } from './edge-weights.js';
import { GraphWriteError } from './errors.js';
import { BASE_NODE_LABEL } from './labels.js';
import { PROTECTED_RELATIONSHIP_TYPES } from './protected-relationships.js';

const PAIRS = [{ sourceId: 'a', targetId: 'b', learningRate: 0.1 }];

const DECAY_INPUT = {
  batchSize: 100,
  decayRate: 0.05,
  peakDays: 30,
  sigma: 15,
  weightFloor: 0.1,
};

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

describe('bell curve edge weight decay', () => {
  it('scans the graph for its own candidates rather than taking named pairs', () => {
    const { cypher } = buildEdgeWeightDecay(DECAY_INPUT);
    expect(cypher).toContain(`MATCH (a:${BASE_NODE_LABEL})-[r]->(b:${BASE_NODE_LABEL})`);
    expect(cypher).not.toContain('UNWIND');
  });

  it('takes the least recently swept edges first and bounds them to the batch size', () => {
    const { cypher, parameters } = buildEdgeWeightDecay(DECAY_INPUT);
    expect(cypher).toContain('r.decayed_at AS sweptAt');
    expect(cypher).toContain('ORDER BY CASE WHEN sweptAt IS NULL THEN 0 ELSE 1 END, sweptAt ASC');
    expect(cypher).toContain('LIMIT $batchSize');
    // LIMIT rejects a float, so this crosses the driver as a Neo4j Integer, not a plain number.
    expect(parameters['batchSize']).toEqual(neo4j.int(100));
  });

  it('measures staleness off the last write rather than off its own cursor', () => {
    const { cypher } = buildEdgeWeightDecay(DECAY_INPUT);
    expect(cypher).toContain(
      'duration.inDays(coalesce(r.updated_at, $now), $now).days AS daysSinceAccess',
    );
    expect(cypher).toContain('daysSinceAccess DESC');
  });

  it('applies the bell curve as one read-and-write statement', () => {
    const { cypher } = buildEdgeWeightDecay(DECAY_INPUT);
    expect(cypher).toContain(
      'WITH r, exp(-1.0 * ((daysSinceAccess - $peakDays) ^ 2.0) / (2.0 * ($sigma ^ 2.0))) AS decay',
    );
    expect(cypher).toContain('before - $decayRate * decay < $weightFloor');
  });

  it('clamps at the floor rather than only bounding from below', () => {
    const { cypher } = buildEdgeWeightDecay(DECAY_INPUT);
    expect(cypher).toContain('THEN $weightFloor');
    expect(cypher).not.toContain('raw > 1.0');
  });

  it('excludes the protected types by the same parameter reinforcement uses', () => {
    const { cypher, parameters } = buildEdgeWeightDecay(DECAY_INPUT);
    expect(cypher).toContain('WHERE NOT type(r) IN $protected');
    expect(parameters['protected']).toEqual([...PROTECTED_RELATIONSHIP_TYPES]);
  });

  it('skips an edge onto a forgotten node at either end', () => {
    const { cypher } = buildEdgeWeightDecay(DECAY_INPUT);
    expect(cypher).toContain('a.forgotten_at IS NULL');
    expect(cypher).toContain('b.forgotten_at IS NULL');
  });

  it('stamps its own cursor and leaves the last-used time alone', () => {
    const { cypher } = buildEdgeWeightDecay(DECAY_INPUT);
    expect(cypher).toContain('r.decayed_at = $now');
    expect(cypher).not.toContain('r.updated_at = $now');
  });

  it('returns the weight before the step alongside the result', () => {
    const { cypher } = buildEdgeWeightDecay(DECAY_INPUT);
    expect(cypher).toContain('before AS previousStrength');
  });

  it('rejects a decay rate outside zero to one', () => {
    expect(() => buildEdgeWeightDecay({ ...DECAY_INPUT, decayRate: 1.5 })).toThrow(
      GraphWriteError,
    );
  });

  it('rejects a weight floor outside zero to one', () => {
    expect(() => buildEdgeWeightDecay({ ...DECAY_INPUT, weightFloor: -0.1 })).toThrow(
      GraphWriteError,
    );
  });

  it('rejects a batch size that is not a positive integer', () => {
    expect(() => buildEdgeWeightDecay({ ...DECAY_INPUT, batchSize: 0 })).toThrow(GraphWriteError);
    expect(() => buildEdgeWeightDecay({ ...DECAY_INPUT, batchSize: 1.5 })).toThrow(
      GraphWriteError,
    );
  });

  it('rejects a peak that is not a positive integer', () => {
    expect(() => buildEdgeWeightDecay({ ...DECAY_INPUT, peakDays: 0 })).toThrow(GraphWriteError);
  });

  it('rejects a non-positive sigma', () => {
    expect(() => buildEdgeWeightDecay({ ...DECAY_INPUT, sigma: 0 })).toThrow(GraphWriteError);
  });
});
