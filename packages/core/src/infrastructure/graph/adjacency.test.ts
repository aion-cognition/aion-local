import type { Driver } from 'neo4j-driver';
import { describe, expect, it } from 'vitest';

import { buildAdjacencyStatement, fetchAdjacency } from './adjacency.js';
import { BITEMPORAL_PROPERTIES } from './bitemporal.js';
import { BASE_NODE_LABEL } from './labels.js';
import { asOf, knewAt, withCurrency } from './read-modes.js';

const AS_OF = new Date('2026-05-01T00:00:00.000Z');
const MIN_STRENGTH = 0.1;
const TOP_K = 64;

describe('buildAdjacencyStatement', () => {
  const statement = buildAdjacencyStatement({
    frontier: ['a', 'b', 'a'],
    visited: ['a', 'a'],
    mode: withCurrency(),
    minStrength: MIN_STRENGTH,
    topK: TOP_K,
  });

  it('expands the whole frontier in one statement, seeking the base label’s id index', () => {
    expect(statement.cypher).toContain('UNWIND $frontier AS frontierId');
    expect(statement.cypher).toContain(
      `MATCH (n:${BASE_NODE_LABEL} { id: frontierId })-[r]-(m:${BASE_NODE_LABEL})`,
    );
    expect(statement.parameters.frontier).toEqual(['a', 'b']);
  });

  it('excludes the frontier node itself and everything already visited', () => {
    expect(statement.cypher).toContain('m.id <> frontierId');
    expect(statement.cypher).toContain('NOT m.id IN $visited');
    expect(statement.parameters.visited).toEqual(['a']);
  });

  it('filters the strength cutoff into the WHERE clause rather than after the fact', () => {
    expect(statement.cypher).toContain('coalesce(r.strength, 1.0) >= $minStrength');
    expect(statement.parameters.minStrength).toBe(MIN_STRENGTH);
  });

  it('caps each frontier node to its strongest K edges before the degree subquery runs', () => {
    expect(statement.cypher).toContain('ORDER BY strength DESC');
    expect(statement.cypher).toContain('[0..$topK]');
    expect(statement.parameters.topK).toBeDefined();
    expect(Number(statement.parameters.topK)).toBe(TOP_K);
    // The cap has to come before this: a hub returning every incident edge means every one of
    // them pays for its own degree count, which is exactly the cost the cap exists to bound.
    const capIndex = statement.cypher.indexOf('[0..$topK]');
    const degreeIndex = statement.cypher.indexOf('COUNT { (m)--() }');
    expect(capIndex).toBeGreaterThan(-1);
    expect(capIndex).toBeLessThan(degreeIndex);
  });

  it('returns exactly what the algorithm weights an edge by', () => {
    expect(statement.cypher).toContain('type(r) AS relationshipType');
    expect(statement.cypher).toContain('coalesce(r.strength, 1.0) AS strength');
    expect(statement.cypher).toContain('coalesce(r.confidence, 1.0) AS confidence');
    expect(statement.cypher).toContain('COUNT { (m)--() } AS degree');
  });

  it('excludes an edge edge_prune has bitemporally closed', () => {
    expect(statement.cypher).toContain(`r.${BITEMPORAL_PROPERTIES.validUntil} IS NULL`);
  });

  it('suppresses forgotten nodes and annotates currency on the neighbour by default', () => {
    expect(statement.cypher).toContain(`m.${BITEMPORAL_PROPERTIES.forgottenAt} IS NULL`);
    expect(statement.cypher).toContain('AS currency');
    expect(statement.cypher).toContain('AS superseded_by');
    expect(statement.parameters.nb_reference).toBeDefined();
  });

  it('composes a world-time read mode into the same statement', () => {
    const timeTravel = buildAdjacencyStatement({
      frontier: ['a'],
      visited: [],
      mode: asOf(AS_OF),
      minStrength: MIN_STRENGTH,
      topK: TOP_K,
    });

    expect(timeTravel.cypher).toContain(`m.${BITEMPORAL_PROPERTIES.validFrom} <= $nb_reference`);
    expect(timeTravel.cypher).toContain(`m.${BITEMPORAL_PROPERTIES.validUntil} IS NULL`);
    // A time-travel read drops the forget suppression: the audit trail survives a forget.
    expect(timeTravel.cypher).not.toContain(BITEMPORAL_PROPERTIES.forgottenAt);
  });

  it('composes a knowledge-time read mode, parameters included', () => {
    const timeTravel = buildAdjacencyStatement({
      frontier: ['a'],
      visited: [],
      mode: knewAt(AS_OF),
      minStrength: MIN_STRENGTH,
      topK: TOP_K,
    });

    expect(timeTravel.cypher).toContain(`m.${BITEMPORAL_PROPERTIES.txFrom} <= $nb_known_at`);
    expect(timeTravel.parameters.nb_known_at).toBeDefined();
  });
});

describe('fetchAdjacency', () => {
  it('does not query at all for an empty frontier', async () => {
    const driver = {
      executeQuery: () => {
        throw new Error('the adjacency fetch queried an empty frontier');
      },
    } as unknown as Driver;

    await expect(
      fetchAdjacency(driver, {
        frontier: [],
        visited: ['a'],
        mode: withCurrency(),
        minStrength: MIN_STRENGTH,
        topK: TOP_K,
      }),
    ).resolves.toEqual([]);
  });
});
