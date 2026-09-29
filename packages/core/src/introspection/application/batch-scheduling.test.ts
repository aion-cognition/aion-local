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
  OPENAI_BATCH_ID,
  openAiBatchApi,
  outputLine,
  responsesAnswer,
  type RecordedCall,
} from '../../infrastructure/providers/test-support/openai-batch-api.fixture.js';
import type { Provider } from '../../infrastructure/providers/types.js';
import {
  enqueueBatchWork,
  readBatchWork,
  waitingBatchWork,
} from '../../infrastructure/sqlite/batch-work.js';
import { SqliteStore, type SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { getLedgerEntry } from '../../infrastructure/sqlite/ops-ledger.js';
import { beginSubstratePairing } from '../../infrastructure/sqlite/publication-control.js';
import { reserveGenerationSpend } from '../../infrastructure/sqlite/spend-ledger.js';
import { NEUTRAL_GRAPH_HEALTH, type HealthSnapshot } from '../domain/health.js';
import type { IntrospectionOperation, OperationOutcome } from '../domain/operation.js';
import { healthFixture } from '../domain/test-support/health.fixture.js';

/**
 * The batch pump inside the real scheduler, one ordinary tick at a time, while other maintenance
 * keeps asking for every tick. Owed work has to be sent and later settled by ticks nobody forced,
 * within a bounded number of them, and so does the cleanup a settled job still owes the vendor; an
 * empty lane, and a lane no run can move, must never take one. The lane is read by the same census
 * a live tick takes; only the graph readings are a fixture.
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

/**
 * Ticks one starvation span holds, which is the wall time owed work takes to reach full
 * relevance.
 */
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

/**
 * Ticks until the condition holds, at most `limit` of them, and returns which operation ran on
 * each.
 */
async function tickUntil(
  introspector: Introspector,
  done: () => boolean,
  limit: number,
): Promise<(string | undefined)[]> {
  const ran: (string | undefined)[] = [];
  while (!done() && ran.length < limit) {
    ran.push(...(await tick(introspector, 1)));
  }
  return ran;
}

function oweTen(): void {
  oweFirst(KEYS.length);
}

function oweFirst(count: number): void {
  for (const workKey of KEYS.slice(0, count)) {
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

    const contested = await tick(engine([...BUSY, pump()], keyless), 3 * SPAN);
    // Alone in the catalog, any claim at all would win a tick within a few of them.
    const quiet = await tick(engine([pump()], keyless), 3 * SPAN);

    expect(contested).not.toContain(BATCH_SETTLEMENT_OPERATION);
    expect(quiet.every((name) => name === undefined)).toBe(true);
    expect(calls).toEqual([]);
    expect(states().every((state) => state === 'pending')).toBe(true);
  });

  it('takes no tick and makes no call on days whose ceiling cannot hold the next batch', async () => {
    oweTen();
    // A real day stops short of the ceiling rather than on it: the hold that would cross it is
    // refused, so the last cent of headroom is never taken. Both UTC days the ticks cover are left
    // a millionth of a dollar short, less than the ten rows' bound.
    const ceilingUsd = CONFIG.anthropic.dailyCeilingUsd;
    for (const day of [START, new Date(START.getTime() + 24 * 60 * 60 * 1000)]) {
      reserveGenerationSpend(db, {
        surface: 'judge',
        route: 'messages',
        maxUsd: ceilingUsd - 0.000001,
        priced: true,
        ceilingUsd,
        now: day,
      });
    }

    const quiet = await tick(engine([pump()]), 3 * SPAN);
    const contested = await tick(engine([...BUSY, pump()]), 3 * SPAN);

    expect(quiet.every((name) => name === undefined)).toBe(true);
    expect(contested).not.toContain(BATCH_SETTLEMENT_OPERATION);
    expect(calls).toEqual([]);
    expect(states().every((state) => state === 'pending')).toBe(true);
  });

  it('retries a vendor deletion that failed after the last row settled, on a later ordinary tick', async () => {
    const [only = ''] = KEYS;
    const remote = openAiBatchApi({
      statuses: ['completed'],
      output: [outputLine(only, responsesAnswer('{"description":"fresh"}'))],
      deleteFailures: 1,
    });
    ({ calls } = remote);
    vi.stubGlobal('fetch', remote.impl);
    oweFirst(1);
    const release = (): unknown =>
      getLedgerEntry(db, `batch_release:openai:${OPENAI_BATCH_ID}`)?.summary;
    const introspector = engine([...BUSY, pump()]);

    const toSettle = await tickUntil(
      introspector,
      () => readBatchWork(db, only)?.state === 'applied',
      2 * SPAN,
    );
    expect(readBatchWork(db, only)?.state).toBe('applied');
    expect(toSettle.filter((name) => name === BATCH_SETTLEMENT_OPERATION)).toHaveLength(2);
    // The answer is applied and no row is left, but the vendor still holds the job's files.
    expect(waitingBatchWork(db, substrateId)).toEqual([]);
    expect(release()).toMatchObject({ batchId: OPENAI_BATCH_ID, released: false });

    const toRelease = await tickUntil(
      introspector,
      () => (release() as { released?: unknown } | undefined)?.released === true,
      SPAN,
    );
    expect(release()).toMatchObject({ released: true });
    expect(toRelease.at(-1)).toBe(BATCH_SETTLEMENT_OPERATION);
    expect(toRelease.slice(0, -1).every((name) => name?.startsWith('busy_'))).toBe(true);

    // Nothing is owed any more, so the pump yields every tick after.
    const after = await tick(introspector, 2 * SPAN);
    expect(after).not.toContain(BATCH_SETTLEMENT_OPERATION);
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
