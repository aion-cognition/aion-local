import type { Driver } from 'neo4j-driver';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readBatchDemand } from './batch-census.js';
import { Introspector } from './engine.js';
import {
  BATCH_SETTLEMENT_OPERATION,
  batchRelevanceScales,
  batchSettlementOperation,
} from './operations/batch-settlement.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import type { Config } from '../../infrastructure/config/schema.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { BatchWorkHandler } from '../../infrastructure/providers/batch-adapter.js';
import {
  openAiBatchApi,
  outputLine,
  responsesAnswer,
  type RecordedCall,
} from '../../infrastructure/providers/test-support/openai-batch-api.fixture.js';
import type { Provider } from '../../infrastructure/providers/types.js';
import { enqueueBatchWork, readBatchWork } from '../../infrastructure/sqlite/batch-work.js';
import { SqliteStore, type SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { beginSubstratePairing } from '../../infrastructure/sqlite/publication-control.js';
import { NEUTRAL_GRAPH_HEALTH, type HealthSnapshot } from '../domain/health.js';
import type { IntrospectionOperation, OperationOutcome } from '../domain/operation.js';
import { healthFixture } from '../domain/test-support/health.fixture.js';

/**
 * The batch pump inside the real scheduler, one ordinary tick at a time, while other maintenance
 * keeps asking for every tick. Owed work has to be sent and later settled by ticks nobody forced,
 * within a bounded number of them; an empty lane, and a lane no run can move, must never take one.
 * The lane is read by the same census a live tick takes; only the graph readings are a fixture.
 */

const START = new Date('2026-09-28T17:30:00.000Z');
const TICK_MS = 15 * 60 * 1000;
const OPENAI_KEY = 'sk-openai-test';
const KEYS = Array.from({ length: 10 }, (_, index) => `refresh-${String(index)}`);

const CONFIG: Config = {
  ...DEFAULTS,
  generation: { ...DEFAULTS.generation, provider: 'openai' },
  openai: { ...DEFAULTS.openai, apiKey: OPENAI_KEY },
  maintenance: { ...DEFAULTS.maintenance, tickMinutes: 15, tier3: false },
};

/** Ticks one starvation span holds, which is the wall time owed work takes to reach full relevance. */
const SPAN = CONFIG.maintenance.starvationCycles;

let dir: string;
let store: SqliteStore;
let db: SqliteHandle;
let substrateId: string;
let now: Date;
let applied: string[];
let calls: RecordedCall[];

function silentLogger(): Logger {
  const noop = (): void => {
    // A test logger that prints nothing, on purpose.
  };
  return { debug: noop, info: noop, warn: noop, error: noop } as unknown as Logger;
}

const handler: BatchWorkHandler = {
  surface: 'judge',
  isCurrent: () => true,
  apply: (item) => {
    applied.push(item.workKey);
    return Promise.resolve();
  },
};

/** Maintenance that always has work, so every tick is contested. */
function busy(name: string): IntrospectionOperation {
  return {
    name,
    bucket: 'quarter-hour',
    relevance: () => 1,
    run: (): Promise<OperationOutcome> =>
      Promise.resolve({ status: 'applied', itemsProcessed: 1, itemsAffected: 1 }),
  };
}

const BUSY = ['busy_a', 'busy_b', 'busy_c', 'busy_d'].map(busy);

function engine(
  operations: readonly IntrospectionOperation[],
  config: Config = CONFIG,
  graph: Partial<HealthSnapshot> = {},
): Introspector {
  return new Introspector(
    {
      driver: {} as Driver,
      db,
      config,
      logger: silentLogger(),
      provider: {} as Provider,
      operations,
    },
    {
      observe: (options) => {
        const at = options.now ?? now;
        return Promise.resolve({
          ...healthFixture(graph),
          cycle: options.cycle ?? 0,
          observedAt: at.toISOString(),
          batch: readBatchDemand(db, config, at),
        });
      },
      now: () => now,
    },
  );
}

function pump(): IntrospectionOperation {
  return batchSettlementOperation([() => handler], batchRelevanceScales(CONFIG));
}

/** Runs ticks a quarter-hour apart and returns, per tick, which operation ran. */
async function tick(introspector: Introspector, count: number): Promise<(string | undefined)[]> {
  const ran: (string | undefined)[] = [];
  for (let index = 0; index < count; index += 1) {
    now = new Date(now.getTime() + TICK_MS);
    const { decision, outcome } = await introspector.tickOnce();
    const acted = outcome !== undefined && decision.kind === 'selected';
    ran.push(acted ? decision.name : undefined);
  }
  return ran;
}

function oweTen(): void {
  for (const workKey of KEYS) {
    enqueueBatchWork(db, {
      workKey,
      substrateId,
      surface: 'judge',
      revalidation: {},
      request: { model: 'gpt-6-luna', max_output_tokens: 64, input: [] },
      provider: 'openai',
      now: START,
    });
  }
}

function states(): readonly (string | undefined)[] {
  return KEYS.map((key) => readBatchWork(db, key)?.state);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-batch-scheduling-'));
  store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  ({ db } = store);
  ({ substrateId } = beginSubstratePairing(db, 1));
  now = START;
  applied = [];
  const remote = openAiBatchApi({
    statuses: ['in_progress', 'completed'],
    output: KEYS.map((key) => outputLine(key, responsesAnswer('{"description":"fresh"}'))),
  });
  ({ calls } = remote);
  vi.stubGlobal('fetch', remote.impl);
});

afterEach(() => {
  vi.unstubAllGlobals();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the batch pump under contested scheduling', () => {
  it('sends owed work and settles it through ordinary ticks, each within one starvation span', async () => {
    oweTen();
    const introspector = engine([...BUSY, pump()]);

    const toSubmit = await tick(introspector, SPAN);
    const sentOn = toSubmit.indexOf(BATCH_SETTLEMENT_OPERATION);
    expect(sentOn).toBeGreaterThanOrEqual(0);
    expect(states().every((state) => state === 'submitted')).toBe(true);
    // The other maintenance kept running around it.
    expect(toSubmit.filter((name) => name !== BATCH_SETTLEMENT_OPERATION)).toHaveLength(SPAN - 1);

    // The first check finds the job still working; the next one settles it.
    const toSettle = await tick(introspector, 2 * SPAN);
    expect(toSettle.filter((name) => name === BATCH_SETTLEMENT_OPERATION)).toHaveLength(2);
    expect(states().every((state) => state === 'applied')).toBe(true);
    expect([...applied].sort()).toEqual([...KEYS].sort());
  });

  it('never takes a tick for an empty lane, busy or quiet', async () => {
    const contested = await tick(engine([...BUSY, pump()]), 3 * SPAN);
    expect(contested).not.toContain(BATCH_SETTLEMENT_OPERATION);

    const quiet = await tick(engine([pump()]), 3 * SPAN);
    expect(quiet.every((name) => name === undefined)).toBe(true);
    expect(calls).toEqual([]);
  });

  it('takes no tick and makes no call for owed work the selected provider has no key for', async () => {
    oweTen();
    const keyless: Config = { ...CONFIG, openai: { ...CONFIG.openai, apiKey: '' } };

    const ran = await tick(engine([...BUSY, pump()], keyless), 3 * SPAN);

    expect(ran).not.toContain(BATCH_SETTLEMENT_OPERATION);
    expect(calls).toEqual([]);
    expect(states().every((state) => state === 'pending')).toBe(true);
  });

  it('never outranks a structural emergency, however long the work has waited', async () => {
    oweTen();
    now = new Date(START.getTime() + 24 * 60 * 60 * 1000);
    const responder: IntrospectionOperation = {
      ...busy('backbone_responder'),
      answers: 'missing_backbone_links',
    };

    const ran = await tick(
      engine([responder, pump()], CONFIG, {
        graph: { ...NEUTRAL_GRAPH_HEALTH, episodesWithoutSession: 3 },
      }),
      1,
    );

    expect(ran).toEqual(['backbone_responder']);
  });
});
