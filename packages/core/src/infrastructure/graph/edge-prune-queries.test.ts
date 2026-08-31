import neo4j from 'neo4j-driver';
import { describe, expect, it } from 'vitest';

import {
  buildEdgeFloorBandCounts,
  buildEdgePruneClose,
  PRUNABLE_ASSOCIATION_TYPES,
} from './edge-prune-queries.js';
import { GraphWriteError } from './errors.js';
import { BASE_NODE_LABEL } from './labels.js';
import { PROTECTED_RELATIONSHIP_TYPES } from './protected-relationships.js';

const CLOSE_INPUT = { batchSize: 100, weightFloor: 0.1, unreinforcedDays: 14 };

describe('PRUNABLE_ASSOCIATION_TYPES', () => {
  it('is exactly CO_OCCURS and SIMILAR, the two types association-queries.ts writes', () => {
    expect(PRUNABLE_ASSOCIATION_TYPES).toEqual(['CO_OCCURS', 'SIMILAR']);
  });

  it('shares nothing with the protected-relationship set', () => {
    const protectedSet = new Set(PROTECTED_RELATIONSHIP_TYPES);
    for (const type of PRUNABLE_ASSOCIATION_TYPES) {
      expect(protectedSet.has(type)).toBe(false);
    }
  });
});

describe('buildEdgePruneClose: the eligibility predicate (floor, age, protected exemption)', () => {
  it('scans the graph for its own candidates, directed like decay rather than named pairs', () => {
    const { cypher } = buildEdgePruneClose(CLOSE_INPUT);
    expect(cypher).toContain(`MATCH (a:${BASE_NODE_LABEL})-[r]->(b:${BASE_NODE_LABEL})`);
    expect(cypher).not.toContain('UNWIND');
  });

  it('restricts to the prunable allowlist and excludes the protected set by parameter', () => {
    const { cypher, parameters } = buildEdgePruneClose(CLOSE_INPUT);
    expect(cypher).toContain('type(r) IN $prunableTypes AND NOT type(r) IN $protected');
    expect(parameters.prunableTypes).toEqual(['CO_OCCURS', 'SIMILAR']);
    expect(parameters.protected).toEqual([...PROTECTED_RELATIONSHIP_TYPES]);
  });

  it('only matches an edge still open, so a second run over the same substrate finds none', () => {
    const { cypher } = buildEdgePruneClose(CLOSE_INPUT);
    expect(cypher).toContain('r.valid_until IS NULL');
  });

  it('is eligible only at or under the floor', () => {
    const { cypher, parameters } = buildEdgePruneClose(CLOSE_INPUT);
    expect(cypher).toContain('coalesce(r.strength, $weightFloor) <= $weightFloor');
    expect(parameters.weightFloor).toBe(0.1);
  });

  it('is eligible only at or past the unreinforced-days threshold, off the last-touched property', () => {
    const { cypher, parameters } = buildEdgePruneClose(CLOSE_INPUT);
    expect(cypher).toContain(
      'duration.inDays(coalesce(r.updated_at, $now), $now).days >= $unreinforcedDays',
    );
    expect(parameters.unreinforcedDays).toBe(14);
  });

  it('closes bitemporally rather than deleting, and returns what it closed', () => {
    const { cypher } = buildEdgePruneClose(CLOSE_INPUT);
    expect(cypher).toContain('r.valid_until = coalesce(r.valid_until, $now)');
    expect(cypher).toContain('r.tx_until = coalesce(r.tx_until, $now)');
    expect(cypher).not.toMatch(/DETACH\s+DELETE/i);
    expect(cypher).toContain('RETURN r.id AS id, type(r) AS type');
  });

  it('skips an edge onto a forgotten node at either end', () => {
    const { cypher } = buildEdgePruneClose(CLOSE_INPUT);
    expect(cypher).toContain('a.forgotten_at IS NULL');
    expect(cypher).toContain('b.forgotten_at IS NULL');
  });

  it('bounds the batch as a Neo4j integer, matching LIMIT', () => {
    const { cypher, parameters } = buildEdgePruneClose(CLOSE_INPUT);
    expect(cypher).toContain('LIMIT $batchSize');
    expect(parameters.batchSize).toEqual(neo4j.int(100));
  });

  it('rejects a batch size that is not a positive integer', () => {
    expect(() => buildEdgePruneClose({ ...CLOSE_INPUT, batchSize: 0 })).toThrow(GraphWriteError);
    expect(() => buildEdgePruneClose({ ...CLOSE_INPUT, batchSize: 1.5 })).toThrow(GraphWriteError);
  });

  it('rejects a weight floor outside zero to one', () => {
    expect(() => buildEdgePruneClose({ ...CLOSE_INPUT, weightFloor: 1.5 })).toThrow(
      GraphWriteError,
    );
  });

  it('rejects an unreinforced-days threshold that is not a positive integer', () => {
    expect(() => buildEdgePruneClose({ ...CLOSE_INPUT, unreinforcedDays: 0 })).toThrow(
      GraphWriteError,
    );
  });
});

describe('buildEdgeFloorBandCounts', () => {
  it('scans the same open, prunable-type population the close statement does', () => {
    const { cypher, parameters } = buildEdgeFloorBandCounts(0.1);
    expect(cypher).toContain(`MATCH (a:${BASE_NODE_LABEL})-[r]->(b:${BASE_NODE_LABEL})`);
    expect(cypher).toContain('type(r) IN $prunableTypes');
    expect(cypher).toContain('r.valid_until IS NULL');
    expect(parameters.prunableTypes).toEqual(['CO_OCCURS', 'SIMILAR']);
  });

  it('splits the count at the floor rather than returning one row per edge', () => {
    const { cypher } = buildEdgeFloorBandCounts(0.1);
    expect(cypher).toContain('count(CASE WHEN strength <= $weightFloor THEN 1 END) AS atFloor');
    expect(cypher).toContain('count(CASE WHEN strength > $weightFloor THEN 1 END) AS aboveFloor');
  });

  it('rejects a weight floor outside zero to one', () => {
    expect(() => buildEdgeFloorBandCounts(-0.1)).toThrow(GraphWriteError);
  });
});
