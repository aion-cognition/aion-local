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
import { CRITICAL_PREEMPTION_GRACE_RUNS } from '../domain/decide.js';
import {
  CRITICAL_MIN_POPULATION,
  NEUTRAL_GRAPH_HEALTH,
  type HealthSnapshot,
} from '../domain/health.js';
import type { IntrospectionOperation, OperationOutcome } from '../domain/operation.js';
import type { Tier3Advisor } from '../domain/tier3.js';
import { healthFixture } from '../domain/test-support/health.fixture.js';
import { Introspector } from './engine.js';
import { backboneRepairOperation } from './operations/backbone-repair.js';
import { vectorBackfillOperation } from './operations/vector-backfill.js';

const EMBED_DIMENSION = 8;
const NOW = new Date('2026-08-29T14:37:00.000Z');
const NEXT_BUCKET = new Date('2026-08-29T15:02:00.000Z');
/** A later quarter-hour window inside the same hour, so an hour-bucketed claim still stands. */
const NEXT_QUARTER = new Date('2026-08-29T14:52:00.000Z');

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

type EngineOverrides = {
  readonly config?: Config;
  readonly tier3Advisor?: Tier3Advisor;
};

function engineFor(
  operations: readonly IntrospectionOperation[],
  snapshots: readonly HealthSnapshot[],
  now: Date = NOW,
  overrides: EngineOverrides = {},
): Introspector {
  let index = 0;
  return new Introspector(
    { driver: harness.driver, db, config: overrides.config ?? config, logger, operations },
    {
      ...(overrides.tier3Advisor === undefined ? {} : { tier3Advisor: overrides.tier3Advisor }),
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

  it('falls through to the next candidate when the winner already holds its bucket', async () => {
    // Wide bucket, top relevance: without a fall-through it would be selected every tick inside
    // the hour and run on none of them, and the narrower operation would wait out the hour.
    const dominant = fakeOperation('hourly_maintenance', { bucket: 'hour', relevance: () => 1 });
    const runnerUp = fakeOperation('quarter_hourly_maintenance', { relevance: () => 0.3 });

    const first = await engineFor([dominant, runnerUp], [healthFixture()]).tickOnce();
    expect(first.decision).toMatchObject({ kind: 'selected', name: 'hourly_maintenance' });
    expect(dominant.calls()).toBe(1);
    expect(runnerUp.calls()).toBe(0);

    // Same hour, next quarter-hour window. The hourly operation is still the top candidate.
    const second = await engineFor([dominant, runnerUp], [healthFixture()], NEXT_QUARTER).tickOnce();

    expect(second.skipped).toBe(false);
    expect(second.decision).toMatchObject({ kind: 'selected', name: 'quarter_hourly_maintenance' });
    expect(dominant.calls()).toBe(1);
    expect(runnerUp.calls()).toBe(1);
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
      bucket: 'quarter-hour',
      relevance: () => 1,
      run: () => Promise.reject(new Error('graph unavailable')),
    };
    const report = await engineFor([operation], [healthFixture()]).tickOnce();

    expect(report.outcome).toMatchObject({ status: 'failed', detail: 'graph unavailable' });
    expect(operationStats(db, 'broken_maintenance')).toMatchObject({ runs: 1, failed: 1 });
  });

  it('preempts a fully relevant routine operation with the registered parity responder', async () => {
    // The shipped operation, not a stand-in: what this certifies is that the catalog carries a
    // responder for the parity condition, which is the half a fake tier-1 operation cannot show.
    const routine = fakeOperation('routine_maintenance');
    const pathological = healthFixture({
      graph: {
        ...NEUTRAL_GRAPH_HEALTH,
        nodes: CRITICAL_MIN_POPULATION * 5,
        vectorExpected: CRITICAL_MIN_POPULATION * 5,
        vectorPresent: 10,
        vectorParity: 0.1,
      },
    });

    const report = await engineFor([routine, vectorBackfillOperation()], [pathological]).tickOnce();

    expect(report.decision).toMatchObject({ kind: 'selected', name: 'vector_backfill', tier: 1 });
    expect(report.decision).toMatchObject({ reason: 'critical: vector_parity' });
    expect(routine.calls()).toBe(0);
  });

  it('answers a missing backbone link with the registered repair', async () => {
    const routine = fakeOperation('routine_maintenance');
    const broken = healthFixture({
      graph: { ...NEUTRAL_GRAPH_HEALTH, nodes: CRITICAL_MIN_POPULATION * 5, episodesWithoutSession: 7 },
    });

    const report = await engineFor([routine, backboneRepairOperation()], [broken]).tickOnce();

    expect(report.decision).toMatchObject({
      kind: 'selected',
      name: 'emergency_relationship_repair',
      tier: 1,
      reason: 'critical: missing_backbone_links',
    });
    expect(routine.calls()).toBe(0);
  });

  it('lets the routine catalog through once a standing emergency stops moving its metric', async () => {
    const routine = fakeOperation('routine_maintenance');
    const standing = healthFixture({
      graph: {
        ...NEUTRAL_GRAPH_HEALTH,
        nodes: CRITICAL_MIN_POPULATION * 5,
        orphanNodes: CRITICAL_MIN_POPULATION * 3,
        orphanShare: 0.6,
      },
    });
    // A pathology nothing in the batch can repair: the operation is selected, runs, changes
    // nothing, and the share it reports is the same on the next tick.
    const emergency = fakeOperation('orphan_cleanup', {
      answers: 'orphan_share',
      relevance: (health) => health.graph.orphanShare,
      measure: (health) => health.graph.orphanShare,
      run: (): Promise<OperationOutcome> =>
        Promise.resolve({ status: 'noop', itemsProcessed: 200, itemsAffected: 0 }),
    });

    let at = NOW;
    let last = await engineFor([routine, emergency], [standing], at).tickOnce();
    for (let cycle = 0; cycle < 8; cycle += 1) {
      at = new Date(at.getTime() + 15 * 60 * 1000);
      last = await engineFor([routine, emergency], [standing], at).tickOnce();
    }

    expect(operationStats(db, 'orphan_cleanup').unchanged).toBeGreaterThanOrEqual(
      CRITICAL_PREEMPTION_GRACE_RUNS,
    );
    expect(last.decision).toMatchObject({ kind: 'selected', name: 'routine_maintenance', tier: 2 });
    expect(routine.calls()).toBeGreaterThan(0);
  });

  /**
   * The one cycle tier 3 is for: the deterministic tiers had nothing left to offer, because
   * the only operation with work to do is already covered by whoever holds its window. The
   * fall-through used to answer with the skipped report before the strategic layer was read,
   * so the layer was silent on exactly the cycles it exists for.
   */
  it('consults tier 3 on a cycle whose only candidate had already lost its window', async () => {
    const strategic: Config = {
      ...config,
      maintenance: { ...config.maintenance, tier3: true },
    };
    const requests: string[] = [];
    const advisor: Tier3Advisor = (request) => {
      requests.push(request.reason);
      return Promise.resolve(undefined);
    };

    const operation = fakeOperation('hourly_strategic', { bucket: 'hour', relevance: () => 1 });
    await engineFor([operation], [healthFixture()], NOW, { config: strategic }).tickOnce();
    expect(operation.calls()).toBe(1);

    // Same hour, next quarter-hour window: the claim is lost and nothing else is relevant.
    const report = await engineFor([operation], [healthFixture()], NEXT_QUARTER, {
      config: strategic,
      tier3Advisor: advisor,
    }).tickOnce();

    expect(report.decision.kind).toBe('tier3');
    expect(report.skipped).toBe(true);
    expect(requests).toHaveLength(1);
    expect(operation.calls()).toBe(1);
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
