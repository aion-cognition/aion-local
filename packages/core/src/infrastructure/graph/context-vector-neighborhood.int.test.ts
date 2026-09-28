import { afterAll, beforeAll, expect, it } from 'vitest';

import { GraphTransaction, runWrite } from './connection.js';
import { readNeighborhood } from './context-vector-sync.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from './test-support/neo4j-harness.fixture.js';
import { computeContextVectors } from '../../reflection/domain/context-vector.js';

let harness: Neo4jHarness;
const NOW = new Date('2026-09-27T12:00:00.000Z');

beforeAll(async () => {
  harness = await startNeo4jHarness();
  await runWrite(
    harness.driver,
    [
      'CREATE (a:AionNode:Memory {id: "a"}), (b:AionNode:Memory {id: "b"})',
      'CREATE (shared:AionNode:Memory {id: "shared", content_vec: [1.0, 2.0, 3.0, 4.0]})',
      'CREATE (pending:AionNode:Memory {id: "pending"})',
      'CREATE (bad:AionNode:Memory {id: "bad", content_vec: "unreadable"})',
      'CREATE (closed:AionNode:Memory {id: "closed", content_vec: [9.0, 9.0, 9.0, 9.0]})',
      'CREATE (a)-[:CO_OCCURS {strength: 0.25}]->(shared)',
      'CREATE (a)-[:RELATED_TO {strength: 0.5}]->(shared)',
      'CREATE (b)-[:CO_OCCURS {strength: 0.75}]->(shared)',
      'CREATE (a)-[:RELATED_TO]->(pending)',
      'CREATE (b)-[:RELATED_TO]->(bad)',
      'CREATE (a)-[:RELATED_TO {valid_until: datetime("2026-09-26T00:00:00Z")}]->(closed)',
      'CREATE (a)-[:CO_OCCURS {strength: 1.0}]->(a)',
      'RETURN a.id AS id',
    ].join('\n'),
    {},
    (row) => row.id,
  );
});

afterAll(async () => {
  await stopNeo4jHarness(harness);
});

it('shares a transferred neighbor vector while preserving every contributing edge', async () => {
  const session = harness.driver.session({ defaultAccessMode: 'READ' });
  try {
    const rows = await session.executeRead((tx) =>
      readNeighborhood(new GraphTransaction(tx), ['a', 'b', 'a'], NOW),
    );
    const shared = rows.filter((row) => row.neighborId === 'shared');
    expect(shared).toHaveLength(3);
    expect(shared.map((row) => [row.nodeId, row.strength]).sort()).toEqual([
      ['a', 0.25],
      ['a', 0.5],
      ['b', 0.75],
    ]);
    expect(shared[0]?.vector).toEqual([1, 2, 3, 4]);
    expect(shared[1]?.vector).toBe(shared[0]?.vector);
    expect(shared[2]?.vector).toBe(shared[0]?.vector);
    expect(rows.find((row) => row.neighborId === 'pending')).toMatchObject({
      stored: false,
      vector: undefined,
    });
    expect(rows.find((row) => row.neighborId === 'bad')).toMatchObject({
      stored: true,
      vector: undefined,
    });
    expect(rows).toHaveLength(5);
    const computed = computeContextVectors(
      shared.flatMap((row) => (row.vector === undefined ? [] : [{ ...row, vector: row.vector }])),
    );
    expect(computed.find((row) => row.id === 'a')).toMatchObject({
      vector: [1, 2, 3, 4],
      neighborCount: 2,
    });
  } finally {
    await session.close();
  }
});
