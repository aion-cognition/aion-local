import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { sweepEdgeDecay } from './decay.js';
import { writeStampedNode } from '../../infrastructure/graph/bitemporal.js';
import { upsertEdge } from '../../infrastructure/graph/edges.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import type { RelationshipType } from '../../infrastructure/graph/relationships.js';
import { edgeStrength as edgeStrengthBetween } from '../../infrastructure/graph/test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger, type Logger } from '../../infrastructure/logging/logger.js';
import { openSqliteHandle, type SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { decaySweepCounters } from '../../infrastructure/sqlite/decay-counters.js';
import { boundedDecay, decayFactor } from '../domain/decay.js';

const EMBED_DIMENSION = 8;
const NOW = new Date('2026-03-01T00:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const DECAY_RATE = 0.05;
const WEIGHT_FLOOR = 0.1;
const PEAK_DAYS = 30;
const SIGMA = 15;

let harness: Neo4jHarness;
let db: SqliteHandle;
let logger: Logger;
let dataDir: string;

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-hebbian-decay-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'error' });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function clearCounters(): void {
  db.exec("DELETE FROM meta WHERE key LIKE 'hebbian_decay:%'");
}

async function seedEntity(id: string): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Entity',
    id,
    properties: { name: id, name_norm: id, type: 'concept' },
    now: NOW,
  });
}

/** `daysAgo` becomes the edge's `updated_at`, the staleness clock the decay sweep reads. */
async function seedEdge(
  type: RelationshipType,
  sourceId: string,
  targetId: string,
  strength: number,
  daysAgo: number,
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

function edgeStrength(
  type: RelationshipType,
  sourceId: string,
  targetId: string,
): Promise<number | undefined> {
  return edgeStrengthBetween(harness.driver, type, sourceId, targetId);
}

function sweep(batchSize = 100) {
  return sweepEdgeDecay(
    { driver: harness.driver, db, logger },
    {
      batchSize,
      decayRate: DECAY_RATE,
      peakDays: PEAK_DAYS,
      sigma: SIGMA,
      weightFloor: WEIGHT_FLOOR,
      now: NOW,
    },
  );
}

/**
 * Decay scans the whole graph rather than draining a queue, so a stale edge from an earlier
 * test in this file is still a candidate in the next one; the harness lease clears the graph
 * once per file, not per test, and product code has no path to a hard delete for these tests
 * to call between them either. Each test below relies on that: it seeds edges either far
 * stalest of anything the file has produced so far, or far freshest, and the earlier tests
 * always run first (vitest keeps declaration order) and always sweep with a batch generous
 * enough to have already flattened whatever they touched down to zero days stale by the time
 * a later test runs. Only counters that isolate to one edge (`report.edgesDecayed` on a
 * scan that can only reach that edge) are asserted exactly; a global scan count is not.
 */
describe('hebbian decay against the graph', () => {
  beforeEach(() => {
    clearCounters();
  });

  it('moves an edge at the peak by exactly the bell curve step the domain computes', async () => {
    await seedEntity('decay-a');
    await seedEntity('decay-b');
    await seedEdge('SIMILAR', 'decay-a', 'decay-b', 0.5, PEAK_DAYS);

    const report = await sweep();

    expect(report).toEqual({ edgesScanned: 1, edgesDecayed: 1 });
    const factor = decayFactor(PEAK_DAYS, PEAK_DAYS, SIGMA);
    expect(await edgeStrength('SIMILAR', 'decay-a', 'decay-b')).toBeCloseTo(
      boundedDecay(0.5, DECAY_RATE, factor, WEIGHT_FLOOR),
      6,
    );
  });

  it('decays a recently touched edge less than one at the peak', async () => {
    await seedEntity('recent-a');
    await seedEntity('recent-b');
    await seedEntity('peak-a');
    await seedEntity('peak-b');
    await seedEdge('SIMILAR', 'recent-a', 'recent-b', 0.5, 1);
    await seedEdge('SIMILAR', 'peak-a', 'peak-b', 0.5, PEAK_DAYS);

    await sweep();

    const recent = (await edgeStrength('SIMILAR', 'recent-a', 'recent-b')) ?? 0.5;
    const peak = (await edgeStrength('SIMILAR', 'peak-a', 'peak-b')) ?? 0.5;
    expect(0.5 - recent).toBeLessThan(0.5 - peak);
  });

  it('decays an edge long past the peak less than one at the peak', async () => {
    await seedEntity('ancient-a');
    await seedEntity('ancient-b');
    await seedEntity('peak2-a');
    await seedEntity('peak2-b');
    await seedEdge('SIMILAR', 'ancient-a', 'ancient-b', 0.5, 120);
    await seedEdge('SIMILAR', 'peak2-a', 'peak2-b', 0.5, PEAK_DAYS);

    await sweep();

    const ancient = (await edgeStrength('SIMILAR', 'ancient-a', 'ancient-b')) ?? 0.5;
    const peak = (await edgeStrength('SIMILAR', 'peak2-a', 'peak2-b')) ?? 0.5;
    expect(0.5 - ancient).toBeLessThan(0.5 - peak);
  });

  it('never crosses the floor however stale the edge', async () => {
    await seedEntity('low-a');
    await seedEntity('low-b');
    await seedEdge('CO_OCCURS', 'low-a', 'low-b', 0.11, PEAK_DAYS);

    await sweep();

    expect(await edgeStrength('CO_OCCURS', 'low-a', 'low-b')).toBeGreaterThanOrEqual(WEIGHT_FLOOR);
  });

  it('leaves a protected edge exactly where it was written', async () => {
    await seedEntity('protected-a');
    await seedEntity('protected-b');
    await seedEdge('PARTICIPATES_IN', 'protected-a', 'protected-b', 0.4, PEAK_DAYS);

    await sweep();

    expect(await edgeStrength('PARTICIPATES_IN', 'protected-a', 'protected-b')).toBe(0.4);
  });

  it('decays the unprotected edge of a pair that also carries a protected one', async () => {
    await seedEntity('mixed-a');
    await seedEntity('mixed-b');
    await seedEdge('PARTICIPATES_IN', 'mixed-a', 'mixed-b', 0.4, PEAK_DAYS);
    await seedEdge('CO_OCCURS', 'mixed-a', 'mixed-b', 0.4, PEAK_DAYS);

    await sweep();

    expect(await edgeStrength('PARTICIPATES_IN', 'mixed-a', 'mixed-b')).toBe(0.4);
    expect(await edgeStrength('CO_OCCURS', 'mixed-a', 'mixed-b')).toBeLessThan(0.4);
  });

  it('takes the stalest edges first and leaves fresher ones for the next run', async () => {
    await seedEntity('stale-a');
    await seedEntity('stale-b');
    await seedEntity('fresh-a');
    await seedEntity('fresh-b');
    await seedEdge('SIMILAR', 'stale-a', 'stale-b', 0.5, 120);
    await seedEdge('SIMILAR', 'fresh-a', 'fresh-b', 0.5, 1);

    const report = await sweep(1);

    expect(report).toEqual({ edgesScanned: 1, edgesDecayed: 1 });
    expect(await edgeStrength('SIMILAR', 'stale-a', 'stale-b')).toBeLessThan(0.5);
    expect(await edgeStrength('SIMILAR', 'fresh-a', 'fresh-b')).toBe(0.5);
  });

  it('resumes past what a bounded run already touched rather than restarting on it', async () => {
    await seedEntity('e1-a');
    await seedEntity('e1-b');
    await seedEntity('e2-a');
    await seedEntity('e2-b');
    await seedEntity('e3-a');
    await seedEntity('e3-b');
    await seedEntity('e4-a');
    await seedEntity('e4-b');
    await seedEdge('SIMILAR', 'e1-a', 'e1-b', 0.5, 100);
    await seedEdge('SIMILAR', 'e2-a', 'e2-b', 0.5, 90);
    await seedEdge('SIMILAR', 'e3-a', 'e3-b', 0.5, 80);
    await seedEdge('SIMILAR', 'e4-a', 'e4-b', 0.5, 70);

    const first = await sweep(2);
    expect(first.edgesScanned).toBe(2);

    const e1AfterFirst = await edgeStrength('SIMILAR', 'e1-a', 'e1-b');
    const e2AfterFirst = await edgeStrength('SIMILAR', 'e2-a', 'e2-b');
    expect(e1AfterFirst).toBeLessThan(0.5);
    expect(e2AfterFirst).toBeLessThan(0.5);
    expect(await edgeStrength('SIMILAR', 'e3-a', 'e3-b')).toBe(0.5);
    expect(await edgeStrength('SIMILAR', 'e4-a', 'e4-b')).toBe(0.5);

    const second = await sweep(2);
    expect(second.edgesScanned).toBe(2);

    expect(await edgeStrength('SIMILAR', 'e1-a', 'e1-b')).toBe(e1AfterFirst);
    expect(await edgeStrength('SIMILAR', 'e2-a', 'e2-b')).toBe(e2AfterFirst);
    expect(await edgeStrength('SIMILAR', 'e3-a', 'e3-b')).toBeLessThan(0.5);
    expect(await edgeStrength('SIMILAR', 'e4-a', 'e4-b')).toBeLessThan(0.5);
  });

  it('applies the same step again when a later sweep reaches the same edge', async () => {
    await seedEntity('twice-a');
    await seedEntity('twice-b');
    await seedEdge('SIMILAR', 'twice-a', 'twice-b', 0.9, PEAK_DAYS);

    await sweep();
    const afterFirst = (await edgeStrength('SIMILAR', 'twice-a', 'twice-b')) ?? 0.9;
    await sweep();
    const afterSecond = (await edgeStrength('SIMILAR', 'twice-a', 'twice-b')) ?? afterFirst;

    // The edge went unused across both sweeps, so both steps are the same size. A sweep that
    // read staleness off a property it writes would flatten the second step to the curve's
    // left tail and report an edge nobody touched as freshly used.
    expect(0.9 - afterFirst).toBeCloseTo(afterFirst - afterSecond, 6);
    expect(0.9 - afterFirst).toBeCloseTo(DECAY_RATE * decayFactor(PEAK_DAYS, PEAK_DAYS, SIGMA), 6);
  });

  it('covers every edge in turn when they are all the same whole number of days stale', async () => {
    const pairs = ['tie-1', 'tie-2', 'tie-3'];
    for (const pair of pairs) {
      await seedEntity(`${pair}-a`);
      await seedEntity(`${pair}-b`);
      await seedEdge('SIMILAR', `${pair}-a`, `${pair}-b`, 0.9, 0);
    }

    // One edge per call, three calls. Staleness truncates to whole days, so these three tie on
    // it exactly; what has to advance the scan is the sweep's own cursor, not the staleness.
    await sweep(1);
    await sweep(1);
    await sweep(1);

    for (const pair of pairs) {
      expect(await edgeStrength('SIMILAR', `${pair}-a`, `${pair}-b`)).toBeLessThan(0.9);
    }
  });

  it('records what it did in meta for the operator surfaces', async () => {
    await seedEntity('meta-a');
    await seedEntity('meta-b');
    await seedEdge('SIMILAR', 'meta-a', 'meta-b', 0.5, PEAK_DAYS);

    // Batch of one: this edge is the only thing in the file this stale at this point, but
    // the scan is still a global one, and the default batch would also sweep whatever
    // earlier tests left behind, muddying the exact counters below.
    await sweep(1);

    expect(decaySweepCounters(db)).toEqual({
      edgesScanned: 1,
      edgesDecayed: 1,
      lastRunAt: NOW.toISOString(),
    });
  });
});
