import type { Driver } from 'neo4j-driver';
import { describe, expect, it } from 'vitest';
import { buildAdjacencyStatement, fetchAdjacency } from './adjacency.js';
import { BITEMPORAL_PROPERTIES } from './bitemporal.js';
import { BASE_NODE_LABEL } from './labels.js';
import { asOf, knewAt, withCurrency } from './read-modes.js';

const AS_OF = new Date('2026-05-01T00:00:00.000Z');

describe('buildAdjacencyStatement', () => {
  const statement = buildAdjacencyStatement({
    frontier: ['a', 'b', 'a'],
    visited: ['a', 'a'],
    mode: withCurrency(),
  });

  it('expands the whole frontier in one statement, seeking the base label’s id index', () => {
    expect(statement.cypher).toContain('UNWIND $frontier AS frontierId');
    expect(statement.cypher).toContain(`MATCH (n:${BASE_NODE_LABEL} { id: frontierId })-[r]-(m:${BASE_NODE_LABEL})`);
    expect(statement.parameters.frontier).toEqual(['a', 'b']);
  });

  it('excludes the frontier node itself and everything already visited', () => {
    expect(statement.cypher).toContain('m.id <> frontierId');
    expect(statement.cypher).toContain('NOT m.id IN $visited');
    expect(statement.parameters.visited).toEqual(['a']);
  });

  it('returns exactly what the algorithm weights an edge by', () => {
    expect(statement.cypher).toContain('type(r) AS relationshipType');
    expect(statement.cypher).toContain('coalesce(r.strength, 1.0) AS strength');
    expect(statement.cypher).toContain('coalesce(r.confidence, 1.0) AS confidence');
    expect(statement.cypher).toContain('COUNT { (m)--() } AS degree');
  });

  it('suppresses forgotten nodes and annotates currency on the neighbour by default', () => {
    expect(statement.cypher).toContain(`m.${BITEMPORAL_PROPERTIES.forgottenAt} IS NULL`);
    expect(statement.cypher).toContain('AS currency');
    expect(statement.cypher).toContain('AS superseded_by');
    expect(statement.parameters.nb_reference).toBeDefined();
  });

  it('composes a world-time read mode into the same statement', () => {
    const timeTravel = buildAdjacencyStatement({ frontier: ['a'], visited: [], mode: asOf(AS_OF) });

    expect(timeTravel.cypher).toContain(`m.${BITEMPORAL_PROPERTIES.validFrom} <= $nb_reference`);
    expect(timeTravel.cypher).toContain(`m.${BITEMPORAL_PROPERTIES.validUntil} IS NULL`);
    // A time-travel read drops the forget suppression: the audit trail survives a forget.
    expect(timeTravel.cypher).not.toContain(BITEMPORAL_PROPERTIES.forgottenAt);
  });

  it('composes a knowledge-time read mode, parameters included', () => {
    const timeTravel = buildAdjacencyStatement({ frontier: ['a'], visited: [], mode: knewAt(AS_OF) });

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

    await expect(fetchAdjacency(driver, { frontier: [], visited: ['a'], mode: withCurrency() })).resolves.toEqual([]);
  });
});
