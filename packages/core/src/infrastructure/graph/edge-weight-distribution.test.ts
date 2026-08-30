import { describe, expect, it } from 'vitest';
import { buildEdgeWeightDistribution, EDGE_WEIGHT_DISTRIBUTION_TYPES } from './edge-weight-distribution.js';
import { BASE_NODE_LABEL } from './labels.js';

describe('bounded edge weight distribution', () => {
  it('names exactly the three evidence-scaled association types', () => {
    expect(EDGE_WEIGHT_DISTRIBUTION_TYPES).toEqual(['SIMILAR', 'CO_OCCURS', 'RELATED_TO']);
  });

  it('resolves both endpoints through the indexed base label', () => {
    const { cypher } = buildEdgeWeightDistribution();
    expect(cypher).toContain(`MATCH (a:${BASE_NODE_LABEL})-[r]->(b:${BASE_NODE_LABEL})`);
  });

  it('scopes the read to the three named types', () => {
    const { cypher, parameters } = buildEdgeWeightDistribution();
    expect(cypher).toContain('WHERE type(r) IN $types');
    expect(parameters['types']).toEqual([...EDGE_WEIGHT_DISTRIBUTION_TYPES]);
  });

  it('skips an edge onto a forgotten node at either end', () => {
    const { cypher } = buildEdgeWeightDistribution();
    expect(cypher).toContain('a.forgotten_at IS NULL');
    expect(cypher).toContain('b.forgotten_at IS NULL');
  });

  it('aggregates min, the three quartile-adjacent percentiles, and max in one pass', () => {
    const { cypher } = buildEdgeWeightDistribution();
    expect(cypher).toContain('min(strength) AS min');
    expect(cypher).toContain('percentileCont(strength, 0.1) AS p10');
    expect(cypher).toContain('percentileCont(strength, 0.5) AS p50');
    expect(cypher).toContain('percentileCont(strength, 0.9) AS p90');
    expect(cypher).toContain('max(strength) AS max');
  });

  it('groups by type so each association type answers on its own scale', () => {
    const { cypher } = buildEdgeWeightDistribution();
    expect(cypher).toContain('type(r) AS relType');
    expect(cypher).toContain('RETURN relType');
  });
});
