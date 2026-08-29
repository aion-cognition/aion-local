import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStore } from './database.js';
import {
  DEFAULT_LAG_SAMPLE_WINDOW,
  listEnrichmentLagSamplesMs,
  p95EnrichmentLagMs,
  recordEnrichmentLagMs,
} from './lag-samples.js';

describe('enrichment lag samples', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-lag-samples-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports no p95 until a sample exists', () => {
    expect(listEnrichmentLagSamplesMs(store.db)).toEqual([]);
    expect(p95EnrichmentLagMs(store.db)).toBeUndefined();
  });

  it('records samples in order and computes the interpolated p95', () => {
    for (let ms = 1; ms <= 100; ms += 1) {
      recordEnrichmentLagMs(store.db, ms * 1000);
    }

    expect(listEnrichmentLagSamplesMs(store.db)).toHaveLength(100);
    // 100 samples of 1000..100000ms: position (100-1)*0.95 = 94.05, interpolating between
    // the 95th and 96th smallest (95000 and 96000).
    expect(p95EnrichmentLagMs(store.db)).toBe(95050);
  });

  it('keeps only the newest samples once the window is full', () => {
    const windowSize = 5;
    for (let ms = 1; ms <= 8; ms += 1) {
      recordEnrichmentLagMs(store.db, ms, windowSize);
    }

    expect(listEnrichmentLagSamplesMs(store.db)).toEqual([4, 5, 6, 7, 8]);
  });

  it('defaults to a 500-sample window', () => {
    for (let ms = 1; ms <= 501; ms += 1) {
      recordEnrichmentLagMs(store.db, ms);
    }

    const samples = listEnrichmentLagSamplesMs(store.db);
    expect(samples).toHaveLength(DEFAULT_LAG_SAMPLE_WINDOW);
    expect(samples[0]).toBe(2);
  });
});
