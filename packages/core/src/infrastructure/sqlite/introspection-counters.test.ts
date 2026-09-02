import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteStore } from './database.js';
import {
  meanOperationDurationMs,
  operationStats,
  recordOperationDuration,
  recordOperationResolution,
} from './introspection-counters.js';

describe('operation resolution tallies', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-counters-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps runs summing to the four tallies once an unmeasured run lands', () => {
    recordOperationResolution(store.db, 'edge_prune', 'improved');
    recordOperationResolution(store.db, 'edge_prune', 'unchanged');
    recordOperationResolution(store.db, 'edge_prune', 'failed');
    recordOperationResolution(store.db, 'edge_prune', 'unmeasured');

    const stats = operationStats(store.db, 'edge_prune');
    expect(stats).toMatchObject({
      runs: 4,
      improved: 1,
      unchanged: 1,
      failed: 1,
      unmeasured: 1,
    });
  });

  it('answers no cost until a run has been timed', () => {
    expect(meanOperationDurationMs(operationStats(store.db, 'edge_prune'))).toBeUndefined();
  });

  it('averages the cost of every timed run and keeps the last one', () => {
    recordOperationDuration(store.db, 'edge_prune', 100);
    recordOperationDuration(store.db, 'edge_prune', 300);

    const stats = operationStats(store.db, 'edge_prune');
    expect(stats.lastDurationMs).toBe(300);
    expect(meanOperationDurationMs(stats)).toBe(200);
  });
});
