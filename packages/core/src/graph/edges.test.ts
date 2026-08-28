import { describe, expect, it } from 'vitest';
import { buildEdgeUpsert, type EdgeUpsert } from './edges.js';
import { GraphWriteError } from './errors.js';
import { BASE_NODE_LABEL } from './labels.js';
import { UNDIRECTED_RELATIONSHIP_TYPES } from './relationships.js';

function clause(cypher: string, keyword: string): string {
  const line = cypher.split('\n').find((entry) => entry.startsWith(keyword));
  if (line === undefined) {
    throw new Error(`no ${keyword} clause in\n${cypher}`);
  }
  return line;
}

const BASE: EdgeUpsert = {
  type: 'MENTIONS',
  sourceId: 'source-1',
  targetId: 'target-1',
  strength: 0.5,
  confidence: 0.6,
  signals: ['episodic'],
  provenance: ['reflection'],
  now: new Date('2026-01-01T00:00:00.000Z'),
};

describe('buildEdgeUpsert policy clauses', () => {
  it('resolves both endpoints through the indexed base label', () => {
    const { cypher } = buildEdgeUpsert(BASE);
    expect(cypher).toContain(`MATCH (a:${BASE_NODE_LABEL} { id: $sourceId })`);
    expect(cypher).toContain(`MATCH (b:${BASE_NODE_LABEL} { id: $targetId })`);
  });

  it('takes the maximum of strength and confidence on collision', () => {
    const { cypher } = buildEdgeUpsert(BASE);
    expect(cypher).toContain(
      'r.strength = CASE WHEN coalesce(r.strength, 0.0) >= $strength THEN r.strength ELSE $strength END',
    );
    expect(cypher).toContain(
      'r.confidence = CASE WHEN coalesce(r.confidence, 0.0) >= $confidence THEN r.confidence ELSE $confidence END',
    );
  });

  it('unions signals and provenance with plain list operations', () => {
    const { cypher } = buildEdgeUpsert(BASE);
    expect(cypher).toContain(
      'r.signals = coalesce(r.signals, []) + [s IN $signals WHERE NOT s IN coalesce(r.signals, [])]',
    );
    expect(cypher).toContain(
      'r.provenance = coalesce(r.provenance, []) + [p IN $provenance WHERE NOT p IN coalesce(r.provenance, [])]',
    );
    expect(cypher.toLowerCase()).not.toContain('apoc');
  });

  it('sums count and never rewrites created_at on collision', () => {
    const { cypher } = buildEdgeUpsert(BASE);
    const onMatch = clause(cypher, 'ON MATCH SET');
    expect(onMatch).toContain('r.count = coalesce(r.count, 0) + $count');
    expect(onMatch).not.toContain('r.created_at');
    expect(onMatch).toContain('r.updated_at = $now');
    expect(clause(cypher, 'ON CREATE SET')).toContain('r.created_at = $now');
  });

  it('defaults count to one and passes zero through for structural edges', () => {
    expect(buildEdgeUpsert(BASE).parameters.count).toBe(1);
    expect(buildEdgeUpsert({ ...BASE, count: 0 }).parameters.count).toBe(0);
  });

  it('omits rationale clauses when no rationale is supplied', () => {
    const without = buildEdgeUpsert(BASE);
    expect(clause(without.cypher, 'ON CREATE SET')).not.toContain('rationale');
    expect(clause(without.cypher, 'ON MATCH SET')).not.toContain('rationale');
    expect(without.parameters).not.toHaveProperty('rationale');

    const withRationale = buildEdgeUpsert({ ...BASE, rationale: 'co-mentioned' });
    expect(withRationale.cypher).toContain('r.rationale = coalesce(r.rationale, $rationale)');
    expect(withRationale.parameters.rationale).toBe('co-mentioned');
  });
});

describe('buildEdgeUpsert endpoints', () => {
  it('normalizes undirected endpoints so a swapped rewrite hits the same edge', () => {
    for (const type of UNDIRECTED_RELATIONSHIP_TYPES) {
      const forward = buildEdgeUpsert({ ...BASE, type, sourceId: 'zz', targetId: 'aa' });
      const reverse = buildEdgeUpsert({ ...BASE, type, sourceId: 'aa', targetId: 'zz' });
      expect(forward.parameters.sourceId).toBe('aa');
      expect(forward.parameters.targetId).toBe('zz');
      expect(reverse.parameters.sourceId).toBe(forward.parameters.sourceId);
      expect(reverse.parameters.targetId).toBe(forward.parameters.targetId);
      expect(reverse.cypher).toBe(forward.cypher);
    }
  });

  it('leaves directed endpoints alone', () => {
    const built = buildEdgeUpsert({ ...BASE, type: 'FOLLOWS', sourceId: 'zz', targetId: 'aa' });
    expect(built.parameters.sourceId).toBe('zz');
    expect(built.parameters.targetId).toBe('aa');
  });

  it('deduplicates the incoming sets so the union stays exact', () => {
    const built = buildEdgeUpsert({
      ...BASE,
      signals: ['episodic', 'episodic', 'semantic'],
      provenance: ['reflection', 'reflection'],
    });
    expect(built.parameters.signals).toEqual(['episodic', 'semantic']);
    expect(built.parameters.provenance).toEqual(['reflection']);
  });
});

describe('buildEdgeUpsert validation', () => {
  it('rejects a relationship type outside the catalog', () => {
    expect(() => buildEdgeUpsert({ ...BASE, type: 'DROP ALL' as never })).toThrow(GraphWriteError);
  });

  it('rejects scores outside 0..1', () => {
    expect(() => buildEdgeUpsert({ ...BASE, strength: 1.5 })).toThrow(GraphWriteError);
    expect(() => buildEdgeUpsert({ ...BASE, confidence: -0.1 })).toThrow(GraphWriteError);
  });

  it('rejects a fractional or negative count', () => {
    expect(() => buildEdgeUpsert({ ...BASE, count: 1.5 })).toThrow(GraphWriteError);
    expect(() => buildEdgeUpsert({ ...BASE, count: -1 })).toThrow(GraphWriteError);
  });

  it('rejects an empty endpoint id', () => {
    expect(() => buildEdgeUpsert({ ...BASE, sourceId: '' })).toThrow(GraphWriteError);
  });
});
