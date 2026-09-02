import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import {
  claimReinforcementSignals,
  countReinforcementSignals,
  deleteReinforcementSignals,
  enqueueReinforcementSignal,
  recordReinforcementFlush,
  reinforcementFlushCounters,
} from '../../infrastructure/sqlite/reinforcement-queue.js';

const TRIGGER = 'reflection:co-extraction';

describe('flush knobs match the shipped configuration', () => {
  it('pins the batch size, learning rate and weight floor to their calibrated values', () => {
    expect(DEFAULTS.hebbian.batchSize).toBe(100);
    expect(DEFAULTS.hebbian.learningRate).toBe(0.1);
    expect(DEFAULTS.hebbian.weightFloor).toBe(0.1);
  });
});

describe('claiming a window of signals', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-hebbian-flush-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** One producer burst: every pair among the ids, stamped with one timestamp. */
  function enqueueBurst(ids: readonly string[], ts: string): void {
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        enqueueReinforcementSignal(store.db, ids[i]!, ids[j]!, TRIGGER, ts);
      }
    }
  }

  it('returns nothing from an empty queue', () => {
    expect(claimReinforcementSignals(store.db, 100)).toEqual([]);
  });

  it('takes the oldest burst first', () => {
    enqueueBurst(['a', 'b'], '2026-01-01T00:00:00.000Z');
    enqueueBurst(['c', 'd'], '2026-01-02T00:00:00.000Z');

    const claimed = claimReinforcementSignals(store.db, 1);
    expect(claimed.map((signal) => signal.sourceId)).toEqual(['a']);
  });

  it('never splits a burst across two claims', () => {
    enqueueBurst(['a', 'b', 'c', 'd', 'e'], '2026-01-01T00:00:00.000Z');

    const claimed = claimReinforcementSignals(store.db, 3);
    expect(claimed).toHaveLength(10);
  });

  it('stops taking bursts once the batch size is covered', () => {
    enqueueBurst(['a', 'b', 'c'], '2026-01-01T00:00:00.000Z');
    enqueueBurst(['d', 'e', 'f'], '2026-01-02T00:00:00.000Z');
    enqueueBurst(['g', 'h', 'i'], '2026-01-03T00:00:00.000Z');

    const claimed = claimReinforcementSignals(store.db, 4);
    expect(claimed).toHaveLength(6);
    expect(new Set(claimed.map((signal) => signal.ts)).size).toBe(2);
  });

  it('separates bursts that share a timestamp but not a trigger', () => {
    enqueueReinforcementSignal(store.db, 'a', 'b', TRIGGER, '2026-01-01T00:00:00.000Z');
    enqueueReinforcementSignal(
      store.db,
      'c',
      'd',
      'recall_co_activation',
      '2026-01-01T00:00:00.000Z',
    );

    const claimed = claimReinforcementSignals(store.db, 1);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.trigger).toBe(TRIGGER);
  });

  it('claims nothing for a batch size of zero', () => {
    enqueueBurst(['a', 'b'], '2026-01-01T00:00:00.000Z');
    expect(claimReinforcementSignals(store.db, 0)).toEqual([]);
  });

  it('leaves the claimed rows in place until they are deleted', () => {
    enqueueBurst(['a', 'b', 'c'], '2026-01-01T00:00:00.000Z');

    const claimed = claimReinforcementSignals(store.db, 100);
    expect(countReinforcementSignals(store.db)).toBe(3);

    const removed = deleteReinforcementSignals(
      store.db,
      claimed.map((signal) => signal.id),
    );
    expect(removed).toBe(3);
    expect(countReinforcementSignals(store.db)).toBe(0);
  });

  it('deletes nothing for an empty id list', () => {
    enqueueBurst(['a', 'b'], '2026-01-01T00:00:00.000Z');
    expect(deleteReinforcementSignals(store.db, [])).toBe(0);
    expect(countReinforcementSignals(store.db)).toBe(1);
  });

  it('deletes past the chunk size in one call', () => {
    const ids: string[] = [];
    for (let index = 0; index < 1200; index += 1) {
      ids.push(
        enqueueReinforcementSignal(
          store.db,
          `s${String(index)}`,
          't',
          TRIGGER,
          '2026-01-01T00:00:00.000Z',
        ),
      );
    }

    expect(deleteReinforcementSignals(store.db, ids)).toBe(1200);
    expect(countReinforcementSignals(store.db)).toBe(0);
  });
});

describe('flush counters', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-hebbian-counters-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts at zero with no run recorded', () => {
    expect(reinforcementFlushCounters(store.db)).toEqual({
      signalsApplied: 0,
      pairsApplied: 0,
      edgesUpdated: 0,
    });
  });

  it('accumulates across runs and keeps the latest run time', () => {
    recordReinforcementFlush(store.db, {
      signalsApplied: 10,
      pairsApplied: 4,
      edgesUpdated: 3,
      at: '2026-01-01T00:00:00.000Z',
    });
    recordReinforcementFlush(store.db, {
      signalsApplied: 5,
      pairsApplied: 2,
      edgesUpdated: 2,
      at: '2026-01-02T00:00:00.000Z',
    });

    expect(reinforcementFlushCounters(store.db)).toEqual({
      signalsApplied: 15,
      pairsApplied: 6,
      edgesUpdated: 5,
      lastRunAt: '2026-01-02T00:00:00.000Z',
    });
  });
});
