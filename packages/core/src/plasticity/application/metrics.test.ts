import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { recordDecaySweep } from '../../infrastructure/sqlite/decay-counters.js';
import { enqueueReinforcementSignal, recordReinforcementFlush } from '../../infrastructure/sqlite/reinforcement-queue.js';
import { plasticityCounters } from './metrics.js';

describe('plasticity counters, sqlite-only', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-plasticity-metrics-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads every field as unmeasured before anything has run', () => {
    expect(plasticityCounters(store.db)).toEqual({
      reinforcement: { signalsApplied: 0, pairsApplied: 0, edgesUpdated: 0 },
      reinforcementDropped: 0,
      reinforcementQueueDepth: 0,
      decay: { edgesScanned: 0, edgesDecayed: 0 },
    });
  });

  it('reports the queue depth as rows still waiting, not a cumulative count', () => {
    enqueueReinforcementSignal(store.db, 'a', 'b', 'recall_co_activation');
    enqueueReinforcementSignal(store.db, 'c', 'd', 'recall_co_activation');

    expect(plasticityCounters(store.db).reinforcementQueueDepth).toBe(2);
  });

  it('surfaces the flush and decay counters recorded by their own operations', () => {
    recordReinforcementFlush(store.db, {
      signalsApplied: 3,
      pairsApplied: 2,
      edgesUpdated: 2,
      at: '2026-08-27T00:00:00.000Z',
    });
    recordDecaySweep(store.db, {
      edgesScanned: 5,
      edgesDecayed: 4,
      at: '2026-08-27T00:00:00.000Z',
    });

    const counters = plasticityCounters(store.db);
    expect(counters.reinforcement).toEqual({
      signalsApplied: 3,
      pairsApplied: 2,
      edgesUpdated: 2,
      lastRunAt: '2026-08-27T00:00:00.000Z',
    });
    expect(counters.decay).toEqual({
      edgesScanned: 5,
      edgesDecayed: 4,
      lastRunAt: '2026-08-27T00:00:00.000Z',
    });
  });
});
