import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStore } from './database.js';
import { recallCadenceCounters, recordRecallOutcome } from './recall-cadence.js';

describe('recall cadence counters', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-recall-cadence-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts at zero', () => {
    expect(recallCadenceCounters(store.db)).toEqual({ totalCalls: 0, emptyPacks: 0 });
  });

  it('counts every call, and empty packs as a subset of it', () => {
    recordRecallOutcome(store.db, { empty: false });
    recordRecallOutcome(store.db, { empty: true });
    recordRecallOutcome(store.db, { empty: false });

    expect(recallCadenceCounters(store.db)).toEqual({ totalCalls: 3, emptyPacks: 1 });
  });

  it('accumulates across separate calls rather than resetting each time', () => {
    recordRecallOutcome(store.db, { empty: true });
    const first = recallCadenceCounters(store.db);
    recordRecallOutcome(store.db, { empty: true });

    expect(first).toEqual({ totalCalls: 1, emptyPacks: 1 });
    expect(recallCadenceCounters(store.db)).toEqual({ totalCalls: 2, emptyPacks: 2 });
  });
});
