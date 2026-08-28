import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStore } from './database.js';
import { enqueueReinforcementSignal, listReinforcementSignals } from './reinforcement-queue.js';

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
});
