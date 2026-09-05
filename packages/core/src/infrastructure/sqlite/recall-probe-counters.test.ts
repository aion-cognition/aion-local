import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteStore } from './database.js';
import {
  recallProbeCounters,
  recordRecallProbeTrial,
  recordServedReferenceReading,
} from './recall-probe-counters.js';

describe('recall probe counters', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-recall-probe-counters-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads as unmeasured before the first probe rather than as a clean record', () => {
    const counters = recallProbeCounters(store.db);

    expect(counters).toEqual({ samples: 0, hits: 0, hitRate: undefined, served: undefined });
  });

  it('accumulates every trial, so the rate is a lifetime figure', () => {
    recordRecallProbeTrial(store.db, { hit: true });
    recordRecallProbeTrial(store.db, { hit: false });
    recordRecallProbeTrial(store.db, { hit: true });

    const counters = recallProbeCounters(store.db);

    expect(counters.samples).toBe(3);
    expect(counters.hits).toBe(2);
    expect(counters.hitRate).toBeCloseTo(2 / 3);
  });

  it('replaces the served reading rather than adding to it', () => {
    recordServedReferenceReading(store.db, {
      items: 10,
      referenced: 4,
      measuredAt: '2026-09-05T00:00:00.000Z',
    });
    recordServedReferenceReading(store.db, {
      items: 12,
      referenced: 9,
      measuredAt: '2026-09-06T00:00:00.000Z',
    });

    expect(recallProbeCounters(store.db).served).toEqual({
      items: 12,
      referenced: 9,
      rate: 0.75,
      measuredAt: '2026-09-06T00:00:00.000Z',
    });
  });

  it('carries no rate when nothing was old enough to judge', () => {
    recordServedReferenceReading(store.db, {
      items: 0,
      referenced: 0,
      measuredAt: '2026-09-05T00:00:00.000Z',
    });

    expect(recallProbeCounters(store.db).served).toEqual({
      items: 0,
      referenced: 0,
      rate: undefined,
      measuredAt: '2026-09-05T00:00:00.000Z',
    });
  });
});
