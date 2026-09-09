import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BASE_NODE_LABEL } from './labels.js';
import { fetchNodeEdges, type NodeEdge } from './node-provenance.js';
import { knewAt } from './read-modes.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from './test-support/neo4j-harness.fixture.js';
import { toGraphDateTime, toGraphInteger } from './values.js';

/**
 * The edge inspection helper against a real server. Two claims only a live graph can settle:
 * a page resumes exactly where the previous one stopped under the keyset, and a traversed
 * relationship carries its own visibility rather than inheriting the endpoint's.
 */

const NOW = new Date('2026-09-01T00:00:00.000Z');
const AFTER = new Date('2026-09-05T00:00:00.000Z');
const NEIGHBOURS = 7;

let harness: Neo4jHarness;

beforeAll(async () => {
  harness = await startNeo4jHarness();
  // No migrations: the claims here are about the read's own predicates and its keyset, and
  // neither needs an index or a constraint to hold.
  await harness.driver.executeQuery(
    `MERGE (n:${BASE_NODE_LABEL} { id: 'centre' })
     SET n.summary = 'the centre', n.tx_from = $now
     WITH n
     UNWIND range(1, $count) AS index
     MERGE (m:${BASE_NODE_LABEL} { id: 'neighbour-' + toString(index) })
     SET m.summary = 'neighbour ' + toString(index), m.tx_from = $now
     MERGE (n)-[r:CO_OCCURS]->(m)
     SET r.created_at = $now, r.strength = 0.5`,
    { now: toGraphDateTime(NOW), count: toGraphInteger(NEIGHBOURS) },
  );
  await harness.driver.executeQuery(
    `MATCH (n:${BASE_NODE_LABEL} { id: 'centre' }), (m:${BASE_NODE_LABEL} { id: 'neighbour-1' })
     MERGE (n)-[r:SIMILAR]->(m)
     SET r.created_at = $after, r.strength = 0.5`,
    { after: toGraphDateTime(AFTER) },
  );
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
});

function ids(edges: readonly NodeEdge[]): readonly string[] {
  return edges.map((edge) => edge.edgeId);
}

describe('node edge inspection', () => {
  it('pages by a stable edge identity and says when a page is not the whole neighbourhood', async () => {
    const first = await fetchNodeEdges(harness.driver, 'centre', { limit: 3 });

    expect(first.edges).toHaveLength(3);
    expect(first.complete).toBe(false);
    expect(first.continuation).toBeDefined();

    const second = await fetchNodeEdges(harness.driver, 'centre', {
      limit: 3,
      ...(first.continuation === undefined ? {} : { after: first.continuation }),
    });

    expect(second.edges).toHaveLength(3);
    expect(second.complete).toBe(false);
    // The keyset resumes rather than repeating: no edge appears on two pages.
    expect(ids(second.edges).some((id) => ids(first.edges).includes(id))).toBe(false);

    const third = await fetchNodeEdges(harness.driver, 'centre', {
      limit: 3,
      ...(second.continuation === undefined ? {} : { after: second.continuation }),
    });

    expect(third.edges).toHaveLength(2);
    expect(third.complete).toBe(true);
    expect(third.continuation).toBeUndefined();
    expect(new Set([...ids(first.edges), ...ids(second.edges), ...ids(third.edges)]).size).toBe(
      NEIGHBOURS + 1,
    );
  }, 120_000);

  it('returns the same page for the same request', async () => {
    const first = await fetchNodeEdges(harness.driver, 'centre', { limit: 4 });
    const again = await fetchNodeEdges(harness.driver, 'centre', { limit: 4 });

    expect(ids(again.edges)).toEqual(ids(first.edges));
  }, 120_000);

  it('does not walk an edge created after the vantage the read was judged against', async () => {
    const before = new Date('2026-09-03T00:00:00.000Z');
    const page = await fetchNodeEdges(harness.driver, 'centre', {
      mode: knewAt(before),
      limit: 50,
    });

    expect(page.complete).toBe(true);
    expect(page.edges.some((edge) => edge.type === 'SIMILAR')).toBe(false);
    expect(page.edges.filter((edge) => edge.type === 'CO_OCCURS')).toHaveLength(NEIGHBOURS);
  }, 120_000);
});
