import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStore } from './database.js';
import {
  DEFAULT_REINFORCEMENT_QUEUE_CAP,
  enqueueReinforcementSignal,
  listReinforcementSignals,
  reinforcementQueueDroppedCount,
} from './reinforcement-queue.js';

describe('reinforcement queue accessors', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-reinforcement-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('enqueues a signal with a fresh id', () => {
    const id = enqueueReinforcementSignal(store.db, 'entity-a', 'entity-b', 'co_activation');
    const signals = listReinforcementSignals(store.db);

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      id,
      sourceId: 'entity-a',
      targetId: 'entity-b',
      trigger: 'co_activation',
    });
  });

  it('accepts an explicit ts', () => {
    enqueueReinforcementSignal(store.db, 'a', 'b', 'co_activation', '2026-01-01T00:00:00.000Z');
    expect(listReinforcementSignals(store.db)[0]?.ts).toBe('2026-01-01T00:00:00.000Z');
  });

  it('lists signals in enqueue order', () => {
    enqueueReinforcementSignal(store.db, 'a', 'b', 'co_activation');
    enqueueReinforcementSignal(store.db, 'c', 'd', 'co_activation');

    const signals = listReinforcementSignals(store.db);
    expect(signals.map((s) => [s.sourceId, s.targetId])).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('defaults the cap to 50000', () => {
    expect(DEFAULT_REINFORCEMENT_QUEUE_CAP).toBe(50_000);
  });

  it('starts the dropped counter at zero', () => {
    expect(reinforcementQueueDroppedCount(store.db)).toBe(0);
  });
});

describe('reinforcement queue cap', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-reinforcement-cap-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('never lets the table grow past the cap', () => {
    for (let i = 0; i < 5; i += 1) {
      enqueueReinforcementSignal(store.db, `s${i}`, `t${i}`, 'co_activation', undefined, 3);
    }

    expect(listReinforcementSignals(store.db)).toHaveLength(3);
  });

  it('drops the oldest rows first, keeping the most recent', () => {
    for (let i = 0; i < 5; i += 1) {
      enqueueReinforcementSignal(store.db, `s${i}`, `t${i}`, 'co_activation', undefined, 3);
    }

    const signals = listReinforcementSignals(store.db);
    expect(signals.map((s) => s.sourceId)).toEqual(['s2', 's3', 's4']);
  });

  it('counts every dropped row in the meta table, cumulatively across calls', () => {
    for (let i = 0; i < 5; i += 1) {
      enqueueReinforcementSignal(store.db, `s${i}`, `t${i}`, 'co_activation', undefined, 3);
    }
    expect(reinforcementQueueDroppedCount(store.db)).toBe(2);

    for (let i = 5; i < 8; i += 1) {
      enqueueReinforcementSignal(store.db, `s${i}`, `t${i}`, 'co_activation', undefined, 3);
    }
    expect(reinforcementQueueDroppedCount(store.db)).toBe(5);
  });

  it('does not drop or count anything while the table sits at or under the cap', () => {
    enqueueReinforcementSignal(store.db, 'a', 'b', 'co_activation', undefined, 3);
    enqueueReinforcementSignal(store.db, 'c', 'd', 'co_activation', undefined, 3);
    enqueueReinforcementSignal(store.db, 'e', 'f', 'co_activation', undefined, 3);

    expect(listReinforcementSignals(store.db)).toHaveLength(3);
    expect(reinforcementQueueDroppedCount(store.db)).toBe(0);
  });

  it('enforces the default cap when the caller passes none', () => {
    const id = enqueueReinforcementSignal(store.db, 'a', 'b', 'co_activation');
    expect(listReinforcementSignals(store.db).map((s) => s.id)).toContain(id);
    expect(reinforcementQueueDroppedCount(store.db)).toBe(0);
  });
});
