import { afterAll, beforeAll, expect, it } from 'vitest';

import { writeStampedNode } from './bitemporal.js';
import { reinforceEdgeWeights } from './edge-weights.js';
import { upsertEdge, type EdgeUpsert } from './edges.js';
import { closeEdge } from './test-support/graph-queries.fixture.js';
import {
  startDedicatedNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from './test-support/neo4j-harness.fixture.js';
import { nodeAssociationHistory } from './topology-queries.js';

let harness: Neo4jHarness;
const AT = new Date('2026-05-01T00:00:00.000Z');
beforeAll(async () => {
  harness = await startDedicatedNeo4jHarness();
  for (const id of ['left', 'right']) {
    await writeStampedNode(harness.driver, {
      label: 'Insight',
      id,
      now: AT,
      properties: { text: id },
    });
  }
}, 120000);
afterAll(async () => {
  await stopNeo4jHarness(harness);
});

it('advances each close and reopen once across both production reopening writers', async () => {
  const edge: EdgeUpsert = {
    type: 'RELATED_TO',
    sourceId: 'left',
    targetId: 'right',
    strength: 0.5,
    confidence: 1,
    signals: [],
    provenance: ['fixture'],
    count: 0,
    now: AT,
  };
  const token = async () => (await nodeAssociationHistory(harness.driver, ['left'])).get('left');
  await upsertEdge(harness.driver, edge);
  expect(await token()).toBe('1@1');
  await closeEdge(harness.driver, 'RELATED_TO', 'left', 'right', AT);
  expect(await token()).toBe('1@2');
  await closeEdge(harness.driver, 'RELATED_TO', 'left', 'right', AT);
  expect(await token()).toBe('1@2');
  await upsertEdge(harness.driver, edge);
  expect(await token()).toBe('1@3');
  await upsertEdge(harness.driver, edge);
  expect(await token()).toBe('1@3');
  await closeEdge(harness.driver, 'RELATED_TO', 'left', 'right', AT);
  expect(await token()).toBe('1@4');
  const reinforcement = {
    pairs: [{ sourceId: 'left', targetId: 'right', learningRate: 0.1 }],
    weightFloor: 0.1,
    now: AT,
  };
  await reinforceEdgeWeights(harness.driver, reinforcement);
  expect(await token()).toBe('1@5');
  await reinforceEdgeWeights(harness.driver, reinforcement);
  expect(await token()).toBe('1@5');
});
