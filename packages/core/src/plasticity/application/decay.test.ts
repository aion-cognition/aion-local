import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import {
  decaySweepCounters,
  recordDecaySweep,
} from '../../infrastructure/sqlite/decay-counters.js';

describe('decay knobs match the shipped configuration', () => {
  it('pins the decay rate, peak, and sigma to their calibrated values', () => {
    expect(DEFAULTS.hebbian.decayRate).toBe(0.05);
    expect(DEFAULTS.hebbian.decayPeakDays).toBe(30);
    expect(DEFAULTS.hebbian.decaySigma).toBe(15);
  });
});

describe('decay sweep counters', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-hebbian-decay-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts at zero with no run recorded', () => {
    expect(decaySweepCounters(store.db)).toEqual({ edgesScanned: 0, edgesDecayed: 0 });
  });

  it('accumulates across runs and keeps the latest run time', () => {
    recordDecaySweep(store.db, {
      edgesScanned: 10,
      edgesDecayed: 6,
      at: '2026-01-01T00:00:00.000Z',
    });
    recordDecaySweep(store.db, {
      edgesScanned: 4,
      edgesDecayed: 1,
      at: '2026-01-02T00:00:00.000Z',
    });

    expect(decaySweepCounters(store.db)).toEqual({
      edgesScanned: 14,
      edgesDecayed: 7,
      lastRunAt: '2026-01-02T00:00:00.000Z',
    });
  });

  it('advances lastRunAt on an empty sweep, the signal that separates quiet from stalled', () => {
    recordDecaySweep(store.db, {
      edgesScanned: 0,
      edgesDecayed: 0,
      at: '2026-01-03T00:00:00.000Z',
    });
    expect(decaySweepCounters(store.db).lastRunAt).toBe('2026-01-03T00:00:00.000Z');
  });
});
