import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runRead } from '../../infrastructure/graph/connection.js';
import { upsertEdge } from '../../infrastructure/graph/edges.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import type { RelationshipType } from '../../infrastructure/graph/relationships.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { writeStampedNode } from '../../infrastructure/graph/bitemporal.js';
import { openLogger, type Logger } from '../../infrastructure/logging/logger.js';
import { openSqliteHandle, type SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  countReinforcementSignals,
  enqueueReinforcementSignal,
  reinforcementFlushCounters,
} from '../../infrastructure/sqlite/reinforcement-queue.js';
import { boundedReinforcement } from '../domain/reinforcement.js';
import { flushReinforcementQueue } from './flush.js';

const EMBED_DIMENSION = 8;
const NOW = new Date('2026-03-01T00:00:00.000Z');
const BURST_TS = '2026-02-28T00:00:00.000Z';
const RECALL_TRIGGER = 'recall_co_activation';
const CO_EXTRACTION_TRIGGER = 'reflection:co-extraction';
const LEARNING_RATE = 0.1;
const WEIGHT_FLOOR = 0.1;

let harness: Neo4jHarness;
let db: SqliteHandle;
let logger: Logger;
let dataDir: string;

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-hebbian-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'error' });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function clearQueue(): void {
  db.exec('DELETE FROM reinforcement_queue');
  db.exec("DELETE FROM meta WHERE key LIKE 'hebbian_flush:%'");
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
    now: NOW,
  });
}

async function edgeStrength(
  type: RelationshipType,
  sourceId: string,
  targetId: string,
): Promise<number | undefined> {
  const rows = await runRead(
    harness.driver,
    `MATCH (a:AionNode { id: $sourceId })-[r:${type}]-(b:AionNode { id: $targetId })
     RETURN r.strength AS strength`,
    { sourceId, targetId },
    (row) => row.strength as number,
  );
  return rows[0];
}

function flush(batchSize = 100) {
  return flushReinforcementQueue(
    { driver: harness.driver, db, logger },
    { batchSize, learningRate: LEARNING_RATE, weightFloor: WEIGHT_FLOOR, now: NOW },
  );
}

describe('hebbian flush against the graph', () => {
  beforeEach(() => {
    clearQueue();
  });

  it('moves an edge by exactly the bounded step the domain computes', async () => {
    await seedEntity('recall-a');
    await seedEntity('recall-b');
    await seedEdge('SIMILAR', 'recall-a', 'recall-b', 0.5);
    enqueueReinforcementSignal(db, 'recall-a', 'recall-b', RECALL_TRIGGER, BURST_TS);

    const report = await flush();

    expect(report).toEqual({
      signalsClaimed: 1,
      pairsApplied: 1,
      edgesUpdated: 1,
      signalsDeleted: 1,
    });
    expect(await edgeStrength('SIMILAR', 'recall-a', 'recall-b')).toBeCloseTo(
      boundedReinforcement(0.5, LEARNING_RATE, WEIGHT_FLOOR),
      10,
    );
  });

  it('applies three tenths of the rate to a co-extraction signal', async () => {
    await seedEntity('reflect-a');
    await seedEntity('reflect-b');
    await seedEdge('CO_OCCURS', 'reflect-a', 'reflect-b', 0.5);
    enqueueReinforcementSignal(db, 'reflect-a', 'reflect-b', CO_EXTRACTION_TRIGGER, BURST_TS);

    await flush();

    expect(await edgeStrength('CO_OCCURS', 'reflect-a', 'reflect-b')).toBeCloseTo(
      boundedReinforcement(0.5, LEARNING_RATE * 0.3, WEIGHT_FLOOR),
      10,
    );
  });

  it('discounts a pair inside a large co-extraction clique', async () => {
    const ids = ['clique-a', 'clique-b', 'clique-c', 'clique-d', 'clique-e', 'clique-f'];
    for (const id of ids) {
      await seedEntity(id);
    }
    await seedEdge('CO_OCCURS', 'clique-a', 'clique-b', 0.5);
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        enqueueReinforcementSignal(
          db,
          ids[i] as string,
          ids[j] as string,
          CO_EXTRACTION_TRIGGER,
          BURST_TS,
        );
      }
    }

    const report = await flush(1);

    expect(report.signalsClaimed).toBe(15);
    expect(report.pairsApplied).toBe(15);
    expect(report.edgesUpdated).toBe(1);
    expect(await edgeStrength('CO_OCCURS', 'clique-a', 'clique-b')).toBeCloseTo(
      boundedReinforcement(0.5, (LEARNING_RATE * 0.3) / 5, WEIGHT_FLOOR),
      10,
    );
  });

  it('folds repeated signals for one pair into a single step', async () => {
    await seedEntity('repeat-a');
    await seedEntity('repeat-b');
    await seedEdge('SIMILAR', 'repeat-a', 'repeat-b', 0.5);
    for (let index = 0; index < 8; index += 1) {
      enqueueReinforcementSignal(
        db,
        'repeat-a',
        'repeat-b',
        RECALL_TRIGGER,
        `2026-02-28T00:00:0${String(index)}.000Z`,
      );
    }

    const report = await flush();

    expect(report.signalsClaimed).toBe(8);
    expect(report.pairsApplied).toBe(1);
    expect(await edgeStrength('SIMILAR', 'repeat-a', 'repeat-b')).toBeCloseTo(
      boundedReinforcement(0.5, LEARNING_RATE, WEIGHT_FLOOR),
      10,
    );
  });

  it('leaves a protected edge exactly where it was written', async () => {
    await seedEntity('protected-a');
    await seedEntity('protected-b');
    await seedEdge('PARTICIPATES_IN', 'protected-a', 'protected-b', 0.4);
    await seedEdge('EXTRACTED_FROM', 'protected-b', 'protected-a', 0.4);
    enqueueReinforcementSignal(db, 'protected-a', 'protected-b', RECALL_TRIGGER, BURST_TS);

    const report = await flush();

    expect(report.edgesUpdated).toBe(0);
    expect(await edgeStrength('PARTICIPATES_IN', 'protected-a', 'protected-b')).toBe(0.4);
    expect(await edgeStrength('EXTRACTED_FROM', 'protected-b', 'protected-a')).toBe(0.4);
  });

  it('moves the unprotected edge of a pair that also carries a protected one', async () => {
    await seedEntity('mixed-a');
    await seedEntity('mixed-b');
    await seedEdge('PARTICIPATES_IN', 'mixed-a', 'mixed-b', 0.4);
    await seedEdge('CO_OCCURS', 'mixed-a', 'mixed-b', 0.4);
    enqueueReinforcementSignal(db, 'mixed-a', 'mixed-b', RECALL_TRIGGER, BURST_TS);

    const report = await flush();

    expect(report.edgesUpdated).toBe(1);
    expect(await edgeStrength('PARTICIPATES_IN', 'mixed-a', 'mixed-b')).toBe(0.4);
    expect(await edgeStrength('CO_OCCURS', 'mixed-a', 'mixed-b')).toBeCloseTo(
      boundedReinforcement(0.4, LEARNING_RATE, WEIGHT_FLOOR),
      10,
    );
  });

  it('never pushes an edge past one however many times it is flushed', async () => {
    await seedEntity('saturate-a');
    await seedEntity('saturate-b');
    await seedEdge('SIMILAR', 'saturate-a', 'saturate-b', 0.9);
    for (let round = 0; round < 25; round += 1) {
      enqueueReinforcementSignal(
        db,
        'saturate-a',
        'saturate-b',
        RECALL_TRIGGER,
        `2026-02-28T00:${String(round).padStart(2, '0')}:00.000Z`,
      );
      await flush(1);
    }

    const strength = await edgeStrength('SIMILAR', 'saturate-a', 'saturate-b');
    expect(strength).toBeLessThanOrEqual(1);
    expect(strength).toBeGreaterThan(0.99);
  });

  it('raises an edge found below the floor rather than leaving it there', async () => {
    await seedEntity('floor-a');
    await seedEntity('floor-b');
    await seedEdge('CO_OCCURS', 'floor-a', 'floor-b', 0.01);
    enqueueReinforcementSignal(db, 'floor-a', 'floor-b', CO_EXTRACTION_TRIGGER, BURST_TS);

    await flush();

    const strength = await edgeStrength('CO_OCCURS', 'floor-a', 'floor-b');
    expect(strength).toBeGreaterThanOrEqual(WEIGHT_FLOOR);
  });

  it('takes the oldest burst and leaves the rest queued', async () => {
    await seedEntity('batch-a');
    await seedEntity('batch-b');
    await seedEntity('batch-c');
    await seedEntity('batch-d');
    await seedEdge('SIMILAR', 'batch-a', 'batch-b', 0.5);
    await seedEdge('SIMILAR', 'batch-c', 'batch-d', 0.5);
    enqueueReinforcementSignal(db, 'batch-a', 'batch-b', RECALL_TRIGGER, '2026-02-28T00:00:00.000Z');
    enqueueReinforcementSignal(db, 'batch-c', 'batch-d', RECALL_TRIGGER, '2026-02-28T00:01:00.000Z');

    const first = await flush(1);

    expect(first.signalsClaimed).toBe(1);
    expect(countReinforcementSignals(db)).toBe(1);
    expect(await edgeStrength('SIMILAR', 'batch-c', 'batch-d')).toBe(0.5);

    const second = await flush(1);
    expect(second.signalsClaimed).toBe(1);
    expect(countReinforcementSignals(db)).toBe(0);
    expect(await edgeStrength('SIMILAR', 'batch-c', 'batch-d')).toBeCloseTo(
      boundedReinforcement(0.5, LEARNING_RATE, WEIGHT_FLOOR),
      10,
    );
  });

  it('applies nothing for a pair with no edge between it, and still clears the row', async () => {
    await seedEntity('lonely-a');
    await seedEntity('lonely-b');
    enqueueReinforcementSignal(db, 'lonely-a', 'lonely-b', RECALL_TRIGGER, BURST_TS);

    const report = await flush();

    expect(report).toMatchObject({ signalsClaimed: 1, pairsApplied: 1, edgesUpdated: 0 });
    expect(countReinforcementSignals(db)).toBe(0);
  });

  it('records what it did in meta for the operator surfaces', async () => {
    await seedEntity('meta-a');
    await seedEntity('meta-b');
    await seedEdge('SIMILAR', 'meta-a', 'meta-b', 0.5);
    enqueueReinforcementSignal(db, 'meta-a', 'meta-b', RECALL_TRIGGER, BURST_TS);

    await flush();

    expect(reinforcementFlushCounters(db)).toEqual({
      signalsApplied: 1,
      pairsApplied: 1,
      edgesUpdated: 1,
      lastRunAt: NOW.toISOString(),
    });
  });

  it('reports an empty queue without touching the graph', async () => {
    const report = await flush();

    expect(report).toEqual({
      signalsClaimed: 0,
      pairsApplied: 0,
      edgesUpdated: 0,
      signalsDeleted: 0,
    });
    expect(reinforcementFlushCounters(db).lastRunAt).toBe(NOW.toISOString());
  });
});
