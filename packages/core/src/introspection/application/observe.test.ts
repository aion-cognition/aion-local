import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readOperationEffectiveness } from './observe.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import {
  recordOperationDuration,
  recordOperationResolution,
} from '../../infrastructure/sqlite/introspection-counters.js';

const CYCLE = 12;

describe('readOperationEffectiveness', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-effectiveness-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function read(name: string, measured: boolean): ReturnType<typeof readOperationEffectiveness> {
    return readOperationEffectiveness(store.db, [{ name, measured }], CYCLE);
  }

  it('reports an operation with no declared metric as unmeasured however often it ran', () => {
    for (let run = 0; run < 5; run += 1) {
      recordOperationResolution(store.db, 'claim_dedup', 'unmeasured');
    }

    expect(read('claim_dedup', false)).toEqual([
      {
        name: 'claim_dedup',
        runs: 5,
        improved: 0,
        failed: 0,
        effectiveness: undefined,
        cyclesSinceSelected: CYCLE,
        lastRunAt: undefined,
        meanDurationMs: undefined,
      },
    ]);
  });

  it('leaves an operation with no declared metric unmeasured after a failure too', () => {
    recordOperationResolution(store.db, 'claim_dedup', 'unmeasured');
    recordOperationResolution(store.db, 'claim_dedup', 'failed');

    const [record] = read('claim_dedup', false);
    // The failure is on the record; what it is not is a verdict on work nothing scored.
    expect(record?.failed).toBe(1);
    expect(record?.effectiveness).toBeUndefined();
  });

  it('scores a declared metric over the runs it actually scored', () => {
    recordOperationResolution(store.db, 'edge_prune', 'improved');
    recordOperationResolution(store.db, 'edge_prune', 'unchanged');
    // One run whose metric could not be read, which must not count against the other two.
    recordOperationResolution(store.db, 'edge_prune', 'unmeasured');

    const [record] = read('edge_prune', true);
    expect(record?.runs).toBe(3);
    expect(record?.effectiveness).toBe(0.5);
  });

  it('reports a declared metric that has scored nothing yet as unmeasured', () => {
    expect(read('edge_prune', true)[0]?.effectiveness).toBeUndefined();
  });

  it('carries the mean run cost through to the snapshot', () => {
    recordOperationDuration(store.db, 'edge_prune', 400);
    recordOperationDuration(store.db, 'edge_prune', 600);

    expect(read('edge_prune', true)[0]?.meanDurationMs).toBe(500);
  });
});
