import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ReinforcementCadence, reinforcementDrain } from './drain.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import type { Config } from '../../infrastructure/config/schema.js';
import { bootstrapBackbone } from '../../infrastructure/graph/backbone.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
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
import { introspectionOperations } from '../../introspection/application/catalog.js';
import { Introspector } from '../../introspection/application/engine.js';
import { REINFORCEMENT_FLUSH_OPERATION } from '../../introspection/application/plasticity-operations.js';
import { RECALL_PACK_EXPOSURE_TRIGGER } from '../domain/reinforcement.js';

/**
 * What the cadence change buys, measured against the scheduler it replaces rather than against a
 * manufactured failure.
 *
 * The old path works: the flush drains in batches toward a per-run ceiling and always has. What
 * it waits on is selection, and selection is a quarter-hour bucket the maintenance loop fills
 * with whatever scores highest across the whole catalog. The baseline here is that real loop,
 * on a real snapshot of a real queue, and the number it reports is how many ticks a steadily
 * filling queue waits before the flush is the operation the loop picks.
 *
 * Both numbers are printed rather than gated. `--reporter=verbose` is what shows them.
 */

/** The named offered load: twelve producers' bursts, fifty pairs each, arriving at once. */
const BURSTS = 12;
const PAIRS_PER_BURST = 50;
const OFFERED = BURSTS * PAIRS_PER_BURST;

/** Short enough to measure, and the only thing this run changes about the shipped cadence. */
const TEST_INTERVAL_MS = 50;

const MINUTE_MS = 60 * 1000;

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let logger: Logger;
let config: Config;

function offerLoad(): void {
  for (let burst = 0; burst < BURSTS; burst += 1) {
    const ts = new Date(Date.UTC(2026, 8, 13, 12, 0, burst)).toISOString();
    for (let pair = 0; pair < PAIRS_PER_BURST; pair += 1) {
      enqueueReinforcementSignal(
        db,
        `burst-${String(burst)}-a${String(pair)}`,
        `burst-${String(burst)}-b${String(pair)}`,
        RECALL_PACK_EXPOSURE_TRIGGER,
        ts,
        DEFAULTS.sqlite.reinforcementQueueCap,
        `burst-${String(burst)}`,
      );
    }
  }
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-drain-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' });
  await runGraphMigrations(harness.driver, db, { embedDimension: DEFAULTS.models.embedDimension });
  await bootstrapBackbone(harness.driver, { memberName: 'Test User' });
  config = DEFAULTS;
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('reinforcement cadence against the scheduler it replaces', () => {
  it('waits on selection under the maintenance tick, and on nothing under its own cadence', async () => {
    offerLoad();
    expect(countReinforcementSignals(db)).toBe(OFFERED);

    // The baseline: the real loop, the real catalog, and a clock that advances one tick per
    // cycle so each cycle claims its own bucket the way two real ticks would.
    const introspector = new Introspector(
      {
        driver: harness.driver,
        db,
        config,
        logger,
        provider: refusingProvider,
        operations: introspectionOperations(config),
      },
      { now: () => nextTick() },
    );
    let ticks = 0;
    let selectedFlushAt: number | undefined;
    for (; ticks < 8 && selectedFlushAt === undefined; ticks += 1) {
      const report = await introspector.tickOnce();
      if (
        report.decision.kind === 'selected' &&
        report.decision.name === REINFORCEMENT_FLUSH_OPERATION
      ) {
        selectedFlushAt = ticks + 1;
      }
    }
    const tickWaitMs =
      selectedFlushAt === undefined
        ? undefined
        : selectedFlushAt * config.maintenance.tickMinutes * MINUTE_MS;
    console.log(
      `maintenance tick: flush selected on cycle ${String(selectedFlushAt ?? -1)} of ${String(ticks)},` +
        ` about ${String(Math.round((tickWaitMs ?? 0) / 1000))}s of wall clock at the shipped interval`,
    );

    // Whatever that cycle drained, the queue is refilled to the same offered load so both
    // measurements answer for the same arrival.
    const remaining = countReinforcementSignals(db);
    if (remaining < OFFERED) {
      offerLoad();
    }
    const before = countReinforcementSignals(db);

    const drain = reinforcementDrain(
      { driver: harness.driver, db, logger },
      {
        batchSize: config.hebbian.batchSize,
        learningRate: config.hebbian.learningRate,
        weightFloor: config.hebbian.weightFloor,
        ceiling: config.hebbian.flushCeiling,
      },
    );
    const cadence = new ReinforcementCadence(drain, { intervalMs: TEST_INTERVAL_MS, logger });
    const started = Date.now();
    cadence.start();
    await waitFor(() => countReinforcementSignals(db) === 0);
    const elapsedMs = Date.now() - started;
    await cadence.stop();

    console.log(
      `dedicated cadence: ${String(before)} signals drained in ${String(elapsedMs)}ms` +
        ` at a ${String(TEST_INTERVAL_MS)}ms interval,` +
        ` about ${String(Math.round((before / Math.max(1, elapsedMs)) * 1000))} signals/s`,
    );

    expect(countReinforcementSignals(db)).toBe(0);
    // The first drain lands one interval in, whatever the maintenance loop was going to do.
    expect(elapsedMs).toBeLessThan(config.maintenance.tickMinutes * MINUTE_MS);
  }, 300_000);

  it('keeps the queue from growing while a steady producer keeps writing to it', async () => {
    const drain = reinforcementDrain(
      { driver: harness.driver, db, logger },
      {
        batchSize: config.hebbian.batchSize,
        learningRate: config.hebbian.learningRate,
        weightFloor: config.hebbian.weightFloor,
        ceiling: config.hebbian.flushCeiling,
      },
    );
    const cadence = new ReinforcementCadence(drain, { intervalMs: TEST_INTERVAL_MS, logger });
    cadence.start();

    // Far above the seven-a-minute figure the plan started from, offered as whole bursts so the
    // clique discount stays computable, for long enough to cross several drains.
    let offered = 0;
    for (let round = 0; round < 6; round += 1) {
      const ts = new Date(Date.UTC(2026, 8, 13, 13, 0, round)).toISOString();
      for (let pair = 0; pair < 20; pair += 1) {
        enqueueReinforcementSignal(
          db,
          `steady-${String(round)}-a${String(pair)}`,
          `steady-${String(round)}-b${String(pair)}`,
          RECALL_PACK_EXPOSURE_TRIGGER,
          ts,
          DEFAULTS.sqlite.reinforcementQueueCap,
          `steady-${String(round)}`,
        );
        offered += 1;
      }
      await pause(TEST_INTERVAL_MS);
    }

    await waitFor(() => countReinforcementSignals(db) === 0);
    await cadence.stop();

    console.log(`steady load: ${String(offered)} signals offered, queue emptied`);
    expect(countReinforcementSignals(db)).toBe(0);
  }, 300_000);
});

let tick = new Date(Date.UTC(2026, 8, 13, 12, 0, 0));

/** One maintenance interval per cycle, so each cycle claims a bucket of its own. */
function nextTick(): Date {
  tick = new Date(tick.getTime() + DEFAULTS.maintenance.tickMinutes * MINUTE_MS);
  return tick;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (predicate()) {
      return;
    }
    await pause(25);
  }
  throw new Error('the queue never emptied');
}
