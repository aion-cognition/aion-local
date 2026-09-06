import type { Driver } from 'neo4j-driver';
import { describe, expect, it } from 'vitest';

import { buildAdjacencyStatement, fetchAdjacency } from './adjacency.js';
import { BITEMPORAL_PROPERTIES } from './bitemporal.js';
import { BASE_NODE_LABEL } from './labels.js';
import { asOf, bitemporalAt, knewAt, withCurrency } from './read-modes.js';

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
    const degreeIndex = statement.cypher.indexOf('AS degree');
    expect(capIndex).toBeGreaterThan(-1);
    expect(capIndex).toBeLessThan(degreeIndex);
  });

  it('returns exactly what the algorithm weights an edge by', () => {
    expect(statement.cypher).toContain('type(r) AS relationshipType');
    expect(statement.cypher).toContain('coalesce(r.strength, 1.0) AS strength');
    expect(statement.cypher).toContain('coalesce(r.confidence, 1.0) AS confidence');
    expect(statement.cypher).toContain('COUNT { (m)--() } AS degree');
  });

  it('prices a neighbour by every relationship stored on it, closed ones included', () => {
    // Traversability and connectivity are different questions: an edge a close ended is not
    // walked and is still part of the node's degree, which is what inhibition is tuned on.
    expect(statement.cypher).toContain('COUNT { (m)--() } AS degree');
    expect(statement.cypher).not.toContain('active_degree');
  });

  it('measures active fan-out beside the stored degree only when asked', () => {
    const measured = buildAdjacencyStatement({
      frontier: ['a'],
      visited: [],
      mode: withCurrency(),
      minStrength: MIN_STRENGTH,
      topK: TOP_K,
      measureActiveDegree: true,
    });

    expect(measured.cypher).toContain('COUNT { (m)--() } AS degree');
    expect(measured.cypher).toContain(
      `COUNT { (m)-[nbd]-() WHERE nbd.${BITEMPORAL_PROPERTIES.validUntil} IS NULL } AS active_degree`,
    );
  });

  it('excludes an edge a bitemporal close has already ended', () => {
    expect(statement.cypher).toContain(`AND r.${BITEMPORAL_PROPERTIES.validUntil} IS NULL`);
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

  it('traverses an edge closed after the world time being read', () => {
    const timeTravel = buildAdjacencyStatement({
      frontier: ['a'],
      visited: [],
      mode: asOf(AS_OF),
      minStrength: MIN_STRENGTH,
      topK: TOP_K,
    });

    expect(timeTravel.cypher).toContain(
      `(r.${BITEMPORAL_PROPERTIES.validUntil} IS NULL` +
        ` OR r.${BITEMPORAL_PROPERTIES.validUntil} > $nb_reference)`,
    );
    // The default read's own predicate, which would hide the edge from history as well.
    expect(timeTravel.cypher).not.toContain(`AND r.${BITEMPORAL_PROPERTIES.validUntil} IS NULL`);
  });

  it('traverses an edge closed after the knowledge time being read', () => {
    const timeTravel = buildAdjacencyStatement({
      frontier: ['a'],
      visited: [],
      mode: knewAt(AS_OF),
      minStrength: MIN_STRENGTH,
      topK: TOP_K,
    });

    expect(timeTravel.cypher).toContain(
      `(r.${BITEMPORAL_PROPERTIES.txUntil} IS NULL` +
        ` OR r.${BITEMPORAL_PROPERTIES.txUntil} > $nb_known_at)`,
    );
    expect(timeTravel.cypher).not.toContain(`AND r.${BITEMPORAL_PROPERTIES.validUntil} IS NULL`);
  });

  it('refuses an edge the substrate had not recorded yet at the knowledge time being read', () => {
    const timeTravel = buildAdjacencyStatement({
      frontier: ['a'],
      visited: [],
      mode: knewAt(AS_OF),
      minStrength: MIN_STRENGTH,
      topK: TOP_K,
    });

    expect(timeTravel.cypher).toContain('r.created_at <= $nb_known_at');
  });

  it('bounds both timelines when the read pins both, on the edge as well as the node', () => {
    const both = buildAdjacencyStatement({
      frontier: ['a'],
      visited: [],
      mode: bitemporalAt(AS_OF, AS_OF),
      minStrength: MIN_STRENGTH,
      topK: TOP_K,
      measureActiveDegree: true,
    });

    // World time asks whether the close had happened; knowledge time asks whether the
    // substrate held the edge at all, which is the arm with a floor to test.
    expect(both.cypher).toContain(
      `(r.${BITEMPORAL_PROPERTIES.validUntil} IS NULL` +
        ` OR r.${BITEMPORAL_PROPERTIES.validUntil} > $nb_reference)` +
        ` AND (r.created_at <= $nb_known_at` +
        ` AND (r.${BITEMPORAL_PROPERTIES.txUntil} IS NULL` +
        ` OR r.${BITEMPORAL_PROPERTIES.txUntil} > $nb_known_at))`,
    );
    expect(both.cypher).toContain('nbd.created_at <= $nb_known_at');
  });

  it('measures a historical neighbour’s fan-out at that moment, degree still physical', () => {
    const timeTravel = buildAdjacencyStatement({
      frontier: ['a'],
      visited: [],
      mode: asOf(AS_OF),
      minStrength: MIN_STRENGTH,
      topK: TOP_K,
      measureActiveDegree: true,
    });

    expect(timeTravel.cypher).toContain('COUNT { (m)--() } AS degree');
    expect(timeTravel.cypher).toContain(
      `COUNT { (m)-[nbd]-() WHERE (nbd.${BITEMPORAL_PROPERTIES.validUntil} IS NULL` +
        ` OR nbd.${BITEMPORAL_PROPERTIES.validUntil} > $nb_reference) } AS active_degree`,
    );
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
