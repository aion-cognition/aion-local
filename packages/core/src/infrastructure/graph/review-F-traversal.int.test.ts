import { afterAll, beforeAll, expect, it } from 'vitest';
import { adjacencyFetchFor } from './adjacency.js';
import { writeStampedNode } from './bitemporal.js';
import { writeBridge } from './bridge-queries.js';
import { upsertEdge } from './edges.js';
import { runGraphMigrations } from './migrations.js';
import { withCurrency } from './read-modes.js';
import { closeEdge } from './test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from './test-support/neo4j-harness.fixture.js';
import { DEFAULTS } from '../config/defaults.js';
import { openSqliteHandle, type SqliteHandle } from '../sqlite/database.js';
import { spreadActivation } from '../../recall/domain/activation.js';

let harness: Neo4jHarness;
let db: SqliteHandle;
const NOW = new Date('2026-09-13T12:00:00Z');
beforeAll(async () => {
  harness = await startNeo4jHarness();
  db = openSqliteHandle({ filePath: ':memory:' });
  await runGraphMigrations(harness.driver, db, { embedDimension: DEFAULTS.models.embedDimension });
}, 300_000);
afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
});
async function node(label: string): Promise<string> {
  return (
    await writeStampedNode(harness.driver, {
      label: 'Entity',
      now: NOW,
      properties: { name: label, text: label },
    })
  ).id;
}
for (const actualLegs of [true, false]) {
  it(`attributes only the actual bridge legs: ${String(actualLegs)}`, async () => {
    const a = await node(`source-${String(actualLegs)}`);
    const b = await node(`target-${String(actualLegs)}`);
    const bridge = await writeBridge(harness.driver, {
      sourceId: a,
      targetId: b,
      sourceCommunity: 1,
      targetCommunity: 2,
      weight: 1,
      summary: 'a model-authored bridge',
      rationale: 'relation',
      sourceRole: 'cause',
      targetRole: 'effect',
      premises: ['a', 'b'],
      author: 'model',
      compatibility: 0.8,
      vector: Array.from({ length: DEFAULTS.models.embedDimension }, (_, n) => (n === 0 ? 1 : 0)),
      now: NOW,
    });
    let seed = a;
    if (!actualLegs) {
      for (const endpoint of [a, b]) {
        await closeEdge(harness.driver, 'RELATED_TO', bridge, endpoint, NOW);
        await closeEdge(harness.driver, 'RELATED_TO', endpoint, bridge, NOW);
      }
      seed = await node('unrelated-left');
      const other = await node('unrelated-right');
      for (const endpoint of [seed, other]) {
        await upsertEdge(harness.driver, {
          type: 'CO_OCCURS',
          sourceId: bridge,
          targetId: endpoint,
          strength: 1,
          confidence: 1,
          signals: ['co-extraction'],
          provenance: ['an unrelated association'],
          count: 1,
          now: NOW,
        });
      }
    }
    const walk = await spreadActivation(
      adjacencyFetchFor(
        harness.driver,
        withCurrency(NOW),
        DEFAULTS.recall.associationStrength,
        100,
      ),
      {
        seeds: [{ nodeId: seed, cueSupported: true }],
        budget: {
          ...DEFAULTS.activation,
          maxHops: 3,
          associationStrength: DEFAULTS.recall.associationStrength,
          maxActivated: 100,
        },
      },
    );
    const legs = walk.bridgeLegs.filter((leg) => leg.bridgeId === bridge);
    console.log(JSON.stringify({ case: 'bridge-leg-identity', actualLegs, legs }));
    if (actualLegs) {
      expect(legs.map((leg) => leg.direction)).toEqual(expect.arrayContaining(['into', 'out']));
    } else {
      expect(legs).toEqual([]);
    }
  }, 300_000);
}
