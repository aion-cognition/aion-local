import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { writeStampedNode } from '../../infrastructure/graph/bitemporal.js';
import { upsertEdge } from '../../infrastructure/graph/edges.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import type { RelationshipType } from '../../infrastructure/graph/relationships.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger, type Logger } from '../../infrastructure/logging/logger.js';
import { openSqliteHandle, type SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { enqueueReinforcementSignal } from '../../infrastructure/sqlite/reinforcement-queue.js';
import { sweepEdgeDecay } from './decay.js';
import { flushReinforcementQueue } from './flush.js';
import { plasticityCounters, plasticitySnapshot } from './metrics.js';

const EMBED_DIMENSION = 8;
const NOW = new Date('2026-03-01T00:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const RECALL_TRIGGER = 'recall_co_activation';

let harness: Neo4jHarness;
let db: SqliteHandle;
let logger: Logger;
let dataDir: string;

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-plasticity-metrics-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'error' });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function clearOperatorState(): void {
  db.exec('DELETE FROM reinforcement_queue');
  db.exec("DELETE FROM meta WHERE key LIKE 'hebbian_flush:%' OR key LIKE 'hebbian_decay:%'");
}

async function seedEntity(id: string): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Entity',
    id,
    properties: { name: id, name_norm: id, type: 'concept' },
    now: NOW,
  });
}

async function seedEdge(
  type: RelationshipType,
  sourceId: string,
  targetId: string,
  strength: number,
  daysAgo = 0,
): Promise<void> {
  await upsertEdge(harness.driver, {
    type,
    sourceId,
    targetId,
    strength,
    confidence: 1,
    signals: ['episodic'],
    provenance: ['test'],
    count: 1,
    now: new Date(NOW.getTime() - daysAgo * DAY_MS),
  });
}

describe('plasticity metrics against the graph', () => {
  beforeEach(() => {
    clearOperatorState();
  });

  it('moves the reinforcement and decay counters under a scripted cycle, and clears the queue', async () => {
    await seedEntity('cycle-a');
    await seedEntity('cycle-b');
    await seedEntity('cycle-c');
    await seedEntity('cycle-d');
    await seedEdge('SIMILAR', 'cycle-a', 'cycle-b', 0.5);
    await seedEdge('SIMILAR', 'cycle-c', 'cycle-d', 0.5, 30);
    enqueueReinforcementSignal(db, 'cycle-a', 'cycle-b', RECALL_TRIGGER, '2026-02-28T00:00:00.000Z');

    expect(plasticityCounters(db).reinforcementQueueDepth).toBe(1);

    await flushReinforcementQueue({ driver: harness.driver, db, logger }, { now: NOW });
    await sweepEdgeDecay(
      { driver: harness.driver, db, logger },
      { batchSize: 1, peakDays: 30, sigma: 15, now: NOW },
    );

    const counters = plasticityCounters(db);
    expect(counters.reinforcementQueueDepth).toBe(0);
    expect(counters.reinforcement.signalsApplied).toBeGreaterThan(0);
    expect(counters.reinforcement.edgesUpdated).toBeGreaterThan(0);
    expect(counters.decay.edgesScanned).toBeGreaterThan(0);
    expect(counters.decay.edgesDecayed).toBeGreaterThan(0);
  });

  it('answers a queue nobody has drained yet as depth without touching the operation counters', async () => {
    await seedEntity('quiet-a');
    await seedEntity('quiet-b');
    enqueueReinforcementSignal(db, 'quiet-a', 'quiet-b', RECALL_TRIGGER);

    const counters = plasticityCounters(db);
    expect(counters.reinforcementQueueDepth).toBe(1);
    expect(counters.reinforcement.lastRunAt).toBeUndefined();
  });

  it('reports the strength distribution of the graph the two operations just moved', async () => {
    await seedEntity('dist-a');
    await seedEntity('dist-b');
    await seedEntity('dist-c');
    await seedEntity('dist-d');
    await seedEntity('dist-e');
    await seedEntity('dist-f');
    await seedEdge('SIMILAR', 'dist-a', 'dist-b', 0.2);
    await seedEdge('SIMILAR', 'dist-c', 'dist-d', 0.5);
    await seedEdge('SIMILAR', 'dist-e', 'dist-f', 0.8);

    const snapshot = await plasticitySnapshot(harness.driver, db);

    const similar = snapshot.edgeWeights.SIMILAR;
    if (similar === undefined) {
      throw new Error('expected at least one live SIMILAR edge');
    }
    expect(similar.count).toBeGreaterThanOrEqual(3);
    expect(similar.min).toBeLessThanOrEqual(0.2);
    expect(similar.max).toBeGreaterThanOrEqual(0.8);
    expect(similar.p50).toBeGreaterThan(similar.min);
    expect(similar.p50).toBeLessThan(similar.max);
  });

  it('leaves a type with no live edge as undefined rather than a zeroed row', async () => {
    const snapshot = await plasticitySnapshot(harness.driver, db);

    expect(snapshot.edgeWeights.RELATED_TO).toBeUndefined();
  });
});
