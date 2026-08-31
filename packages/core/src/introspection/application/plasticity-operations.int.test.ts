import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { memoryDecayOperation, reinforcementFlushOperation } from './plasticity-operations.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import type { Config } from '../../infrastructure/config/schema.js';
import { writeStampedNode } from '../../infrastructure/graph/bitemporal.js';
import { upsertEdge } from '../../infrastructure/graph/edges.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import { edgeStrength as edgeStrengthBetween } from '../../infrastructure/graph/test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger, type Logger } from '../../infrastructure/logging/logger.js';
import { refusingProvider } from '../../infrastructure/providers/test-support/refusing-provider.fixture.js';
import { openSqliteHandle, type SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  countReinforcementSignals,
  enqueueReinforcementSignal,
} from '../../infrastructure/sqlite/reinforcement-queue.js';
import { boundedReinforcement } from '../../plasticity/domain/reinforcement.js';
import type { OperationContext } from '../domain/operation.js';
import { healthFixture } from '../domain/test-support/health.fixture.js';

/**
 * The operation-level counterpart to `plasticity/application/flush.int.test.ts` and
 * `decay.int.test.ts`: those pin the per-batch fold and decay math directly, this pins that
 * the drain loop and the proportional scan quota only change how many times that math runs,
 * never what it computes.
 */

const EMBED_DIMENSION = DEFAULTS.models.embedDimension;
const NOW = new Date('2026-08-31T00:00:00.000Z');
const RECALL_TRIGGER = 'recall_co_activation';
const LEARNING_RATE = 0.1;
const WEIGHT_FLOOR = 0.1;

let harness: Neo4jHarness;
let db: SqliteHandle;
let logger: Logger;
let dataDir: string;

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-plasticity-ops-'));
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

function edgeStrength(sourceId: string, targetId: string): Promise<number | undefined> {
  return edgeStrengthBetween(harness.driver, 'SIMILAR', sourceId, targetId);
}

function ctxFor(config: Config, overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    driver: harness.driver,
    db,
    config,
    logger,
    provider: refusingProvider,
    health: healthFixture(),
    now: NOW,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('reinforcement_flush: multi-batch drain against the graph', () => {
  beforeEach(() => {
    clearQueue();
  });

  it('drains every queued burst in one run when the backlog fits under the ceiling', async () => {
    const config: Config = {
      ...DEFAULTS,
      hebbian: { ...DEFAULTS.hebbian, batchSize: 2, flushCeiling: 100 },
    };
    for (let i = 0; i < 5; i += 1) {
      await seedEntity(`drain-${String(i)}-a`);
      await seedEntity(`drain-${String(i)}-b`);
      await upsertEdge(harness.driver, {
        type: 'SIMILAR',
        sourceId: `drain-${String(i)}-a`,
        targetId: `drain-${String(i)}-b`,
        strength: 0.5,
        confidence: 1,
        signals: ['episodic'],
        provenance: ['test'],
        count: 1,
        now: NOW,
      });
      enqueueReinforcementSignal(
        db,
        `drain-${String(i)}-a`,
        `drain-${String(i)}-b`,
        RECALL_TRIGGER,
        `2026-08-30T00:00:0${String(i)}.000Z`,
      );
    }

    const outcome = await reinforcementFlushOperation().run(ctxFor(config));

    // Five one-row bursts at batchSize 2 take three calls (2, 2, 1) plus the empty call that
    // finds the queue drained, all inside a ceiling of 100.
    expect(outcome.status).toBe('applied');
    expect(outcome.itemsProcessed).toBe(5);
    expect(outcome.detail).toContain('4 batch(es)');
    expect(countReinforcementSignals(db)).toBe(0);
    for (let i = 0; i < 5; i += 1) {
      expect(await edgeStrength(`drain-${String(i)}-a`, `drain-${String(i)}-b`)).toBeCloseTo(
        boundedReinforcement(0.5, LEARNING_RATE, WEIGHT_FLOOR),
        10,
      );
    }
  }, 60_000);

  it('stops at the ceiling and leaves the rest of the backlog queued for the next tick', async () => {
    const config: Config = {
      ...DEFAULTS,
      hebbian: { ...DEFAULTS.hebbian, batchSize: 2, flushCeiling: 4 },
    };
    for (let i = 0; i < 10; i += 1) {
      await seedEntity(`ceiling-${String(i)}-a`);
      await seedEntity(`ceiling-${String(i)}-b`);
      enqueueReinforcementSignal(
        db,
        `ceiling-${String(i)}-a`,
        `ceiling-${String(i)}-b`,
        RECALL_TRIGGER,
        `2026-08-30T00:00:${String(i).padStart(2, '0')}.000Z`,
      );
    }

    const outcome = await reinforcementFlushOperation().run(ctxFor(config));

    // Two calls of two bursts each reach the ceiling of 4 exactly; the loop stops there
    // rather than reading the eight bursts still queued.
    expect(outcome.itemsProcessed).toBe(4);
    expect(outcome.detail).toContain('2 batch(es)');
    expect(countReinforcementSignals(db)).toBe(6);
  }, 60_000);

  it('applies the same bounded step run through the loop as run through repeated manual calls', async () => {
    await seedEntity('loop-saturate-a');
    await seedEntity('loop-saturate-b');
    await upsertEdge(harness.driver, {
      type: 'SIMILAR',
      sourceId: 'loop-saturate-a',
      targetId: 'loop-saturate-b',
      strength: 0.9,
      confidence: 1,
      signals: ['episodic'],
      provenance: ['test'],
      count: 1,
      now: NOW,
    });
    for (let round = 0; round < 25; round += 1) {
      enqueueReinforcementSignal(
        db,
        'loop-saturate-a',
        'loop-saturate-b',
        RECALL_TRIGGER,
        `2026-08-30T00:${String(round).padStart(2, '0')}:00.000Z`,
      );
    }
    const config: Config = {
      ...DEFAULTS,
      hebbian: { ...DEFAULTS.hebbian, batchSize: 1, flushCeiling: 100 },
    };

    await reinforcementFlushOperation().run(ctxFor(config));

    // The same 25-round bounded-step sequence `flush.int.test.ts` pins by calling
    // `flush(1)` in a hand-rolled loop: 25 single-signal batches, run here by the operation's
    // own drain loop instead, land on the identical value.
    let expected = 0.9;
    for (let round = 0; round < 25; round += 1) {
      expected = boundedReinforcement(expected, LEARNING_RATE, WEIGHT_FLOOR);
    }
    const strength = await edgeStrength('loop-saturate-a', 'loop-saturate-b');
    expect(strength).toBeCloseTo(expected, 10);
  }, 60_000);
});

describe('memory_decay: proportional scan quota against the graph', () => {
  it('scans the ceil of the fraction of decayable edges the snapshot reported, stalest first', async () => {
    const config: Config = {
      ...DEFAULTS,
      hebbian: { ...DEFAULTS.hebbian, decayScanFraction: 0.5 },
    };
    // Near the 30-day peak so a scanned edge visibly moves; an edge far past the peak decays
    // by a Gaussian-tail amount too small to distinguish from zero at this precision, which
    // would make "was it scanned" and "did it move" the same question when they are not.
    const daysAgoByIndex = [36, 33, 30, 3, 2, 1];
    for (let i = 0; i < 6; i += 1) {
      await seedEntity(`quota-${String(i)}-a`);
      await seedEntity(`quota-${String(i)}-b`);
      // No edge in this file has been swept yet, so the sweep order ties on "never swept" and
      // falls back to days-stale, descending: indices 0, 1, 2 are the three the fraction takes.
      const daysAgo = daysAgoByIndex[i]!;
      await upsertEdge(harness.driver, {
        type: 'SIMILAR',
        sourceId: `quota-${String(i)}-a`,
        targetId: `quota-${String(i)}-b`,
        strength: 0.5,
        confidence: 1,
        signals: ['episodic'],
        provenance: ['test'],
        count: 1,
        now: new Date(NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000),
      });
    }

    // The snapshot, not a fresh graph read, is what the quota is derived from: the operation
    // must not observe on its own.
    const health = healthFixture({ graph: { ...healthFixture().graph, decayableEdges: 6 } });
    const outcome = await memoryDecayOperation().run(ctxFor(config, { health }));

    expect(outcome.itemsProcessed).toBe(3);
    for (let i = 0; i < 3; i += 1) {
      expect(await edgeStrength(`quota-${String(i)}-a`, `quota-${String(i)}-b`)).toBeLessThan(0.5);
    }
    for (let i = 3; i < 6; i += 1) {
      expect(await edgeStrength(`quota-${String(i)}-a`, `quota-${String(i)}-b`)).toBe(0.5);
    }
  }, 60_000);
});
