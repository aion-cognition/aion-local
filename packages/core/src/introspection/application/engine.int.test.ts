import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import type { Config } from '../../infrastructure/config/schema.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger, type Logger } from '../../infrastructure/logging/logger.js';
import { openSqliteHandle, type SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { operationStats } from '../../infrastructure/sqlite/introspection-counters.js';
import { getLedgerEntry } from '../../infrastructure/sqlite/ops-ledger.js';
import { operationBucketKey } from '../domain/buckets.js';
import { CRITICAL_MIN_POPULATION } from '../domain/decide.js';
import { NEUTRAL_GRAPH_HEALTH, type HealthSnapshot } from '../domain/health.js';
import type { IntrospectionOperation, OperationOutcome } from '../domain/operation.js';
import { healthFixture } from '../domain/test-support/health.fixture.js';
import { Introspector } from './engine.js';

const EMBED_DIMENSION = 8;
const NOW = new Date('2026-08-29T14:37:00.000Z');
const NEXT_BUCKET = new Date('2026-08-29T15:02:00.000Z');

let harness: Neo4jHarness;
let db: SqliteHandle;
let logger: Logger;
let dataDir: string;

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-introspector-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'error' });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  db.exec("DELETE FROM meta WHERE key LIKE 'introspection:%'");
  db.exec("DELETE FROM ops_ledger WHERE key LIKE 'intro:%'");
});

const config: Config = {
  ...DEFAULTS,
  maintenance: { ...DEFAULTS.maintenance, tickMinutes: 15, urgencyThreshold: 0.2 },
};

type FakeOperation = IntrospectionOperation & { readonly calls: () => number };

/**
 * A counted stand-in for a real maintenance operation. `queueDepth` is what it reports moving,
 * so the engine's learning path is exercised against a metric it can actually see change.
 */
function fakeOperation(
  name: string,
  overrides: Partial<IntrospectionOperation> = {},
): FakeOperation {
  let calls = 0;
  return {
    name,
    tier: 2,
    bucket: 'quarter-hour',
    relevance: () => 1,
    measure: (health) => health.plasticity.reinforcementQueueDepth,
    improves: 'lower',
    run: (): Promise<OperationOutcome> => {
      calls += 1;
      return Promise.resolve({ status: 'applied', itemsProcessed: 3, itemsAffected: 2 });
    },
    calls: () => calls,
    ...overrides,
  };
}

function engineFor(
  operations: readonly IntrospectionOperation[],
  snapshots: readonly HealthSnapshot[],
  now: Date = NOW,
): Introspector {
  let index = 0;
  return new Introspector(
    { driver: harness.driver, db, config, logger, operations },
    {
      observe: (options) => {
        const snapshot = snapshots[Math.min(index, snapshots.length - 1)] ?? healthFixture();
        index += 1;
        return Promise.resolve({ ...snapshot, cycle: options.cycle ?? 0 });
      },
      now: () => now,
    },
  );
}

describe('Introspector', () => {
  it('runs the selected operation and records what it did in the ledger', async () => {
    const operation = fakeOperation('fake_maintenance');
    const report = await engineFor([operation], [healthFixture()]).tickOnce();

    expect(report.decision).toMatchObject({ kind: 'selected', name: 'fake_maintenance', tier: 2 });
    expect(report.outcome).toMatchObject({ status: 'applied', itemsAffected: 2 });
    expect(operation.calls()).toBe(1);

    const entry = getLedgerEntry(db, operationBucketKey('fake_maintenance', 'quarter-hour', NOW));
    expect(entry?.summary).toMatchObject({
      operation: 'fake_maintenance',
      status: 'applied',
      itemsProcessed: 3,
      itemsAffected: 2,
    });
  });

  it('runs an operation once per bucket, whichever instance ticks', async () => {
    const first = fakeOperation('shared_maintenance');
    const second = fakeOperation('shared_maintenance');

    await engineFor([first], [healthFixture()]).tickOnce();
    const losing = await engineFor([second], [healthFixture()]).tickOnce();

    expect(first.calls()).toBe(1);
    expect(second.calls()).toBe(0);
    expect(losing.skipped).toBe(true);

    // The window turns over and the second instance takes the next one.
    await engineFor([second], [healthFixture()], NEXT_BUCKET).tickOnce();
    expect(second.calls()).toBe(1);
  });

  it('scores the run against the next snapshot rather than the one it decided from', async () => {
    const before = healthFixture({
      plasticity: { reinforcementQueueDepth: 40, reinforcementLastRunAt: undefined, decayLastRunAt: undefined },
    });
    const after = healthFixture({
      plasticity: { reinforcementQueueDepth: 2, reinforcementLastRunAt: undefined, decayLastRunAt: undefined },
    });

    // Relevant only while the queue is deep, so the second tick scores the first run without
    // starting another one.
    const operation = fakeOperation('measured_maintenance', {
      relevance: (health) => (health.plasticity.reinforcementQueueDepth > 10 ? 1 : 0),
    });
    await engineFor([operation], [before]).tickOnce();

    const pending = operationStats(db, 'measured_maintenance');
    expect(pending.pendingMeasure).toBe(40);
    expect(pending.runs).toBe(0);

    const second = await engineFor([operation], [after], NEXT_BUCKET).tickOnce();
    expect(second.decision.kind).toBe('idle');
    expect(second.resolved).toEqual([{ name: 'measured_maintenance', resolution: 'improved' }]);
    const scored = operationStats(db, 'measured_maintenance');
    expect(scored).toMatchObject({ runs: 1, improved: 1 });
    expect(scored.pendingMeasure).toBeUndefined();
  });

  it('records a throwing operation as failed and keeps ticking', async () => {
    const operation: IntrospectionOperation = {
      name: 'broken_maintenance',
      tier: 2,
      bucket: 'quarter-hour',
      relevance: () => 1,
      run: () => Promise.reject(new Error('graph unavailable')),
    };
    const report = await engineFor([operation], [healthFixture()]).tickOnce();

    expect(report.outcome).toMatchObject({ status: 'failed', detail: 'graph unavailable' });
    expect(operationStats(db, 'broken_maintenance')).toMatchObject({ runs: 1, failed: 1 });
  });

  it('preempts a fully relevant routine operation with a critical one', async () => {
    const routine = fakeOperation('routine_maintenance');
    const emergency = fakeOperation('vector_backfill', {
      tier: 1,
      relevance: (health) => (health.graph.vectorParity < 0.8 ? 1 : 0),
    });
    const pathological = healthFixture({
      graph: {
        ...NEUTRAL_GRAPH_HEALTH,
        nodes: CRITICAL_MIN_POPULATION * 5,
        vectorExpected: CRITICAL_MIN_POPULATION * 5,
        vectorPresent: 10,
        vectorParity: 0.1,
      },
    });

    const report = await engineFor([routine, emergency], [pathological]).tickOnce();

    expect(report.decision).toMatchObject({ kind: 'selected', name: 'vector_backfill', tier: 1 });
    expect(report.decision).toMatchObject({ reason: 'critical: vector_parity' });
    expect(emergency.calls()).toBe(1);
    expect(routine.calls()).toBe(0);
  });

  it('leaves the cycle idle when nothing is relevant', async () => {
    const operation = fakeOperation('quiet_maintenance', { relevance: () => 0 });
    const report = await engineFor([operation], [healthFixture()]).tickOnce();

    expect(report.decision.kind).toBe('idle');
    expect(operation.calls()).toBe(0);
    expect(report.outcome).toBeUndefined();
  });

  it('idles and backs off when observation itself fails', async () => {
    const operation = fakeOperation('unreached_maintenance');
    const engine = new Introspector(
      { driver: harness.driver, db, config, logger, operations: [operation] },
      { observe: () => Promise.reject(new Error('bolt closed')), now: () => NOW },
    );

    const first = await engine.tickOnce();
    expect(first.decision).toEqual({ kind: 'idle', reason: 'observation failed' });
    expect(first.health.degraded).toContain('graph');
    expect(operation.calls()).toBe(0);
    expect(engine.backoffFactor).toBe(2);

    await engine.tickOnce();
    expect(engine.backoffFactor).toBe(4);
    expect(engine.nextDelayMs(0.5)).toBe(engine.tickMs * 4);
  });

  it('stops cleanly and aborts the signal operations are handed', async () => {
    let seen: AbortSignal | undefined;
    const operation = fakeOperation('signal_maintenance', {
      run: (ctx): Promise<OperationOutcome> => {
        seen = ctx.signal;
        return Promise.resolve({ status: 'noop', itemsProcessed: 0, itemsAffected: 0 });
      },
    });
    const engine = engineFor([operation], [healthFixture()]);
    engine.start();
    await engine.tickOnce();
    expect(seen?.aborted).toBe(false);

    await engine.stop();
    expect(seen?.aborted).toBe(true);
  });
});
