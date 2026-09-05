import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readGeneration, readOperationEffectiveness, readQueue } from './observe.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { recordGenerationOutcome } from '../../infrastructure/sqlite/generation-counters.js';
import {
  recordOperationDuration,
  recordOperationResolution,
} from '../../infrastructure/sqlite/introspection-counters.js';
import { recordCueOutcome } from '../../infrastructure/sqlite/recall-samples.js';
import { enqueueReinforcementSignal } from '../../infrastructure/sqlite/reinforcement-queue.js';

const CYCLE = 12;

const NOW = new Date('2026-09-05T12:00:00.000Z');

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

describe('readQueue', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-queue-health-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads an untouched substrate as unmeasured on cues rather than as clean', () => {
    const queue = readQueue(store.db, DEFAULTS, NOW);

    expect(queue.cueDegradedRate).toBeUndefined();
    expect(queue.reinforcementDropped).toBe(0);
  });

  it('carries the degraded-cue rate the operator already had', () => {
    recordCueOutcome(store.db, true);
    recordCueOutcome(store.db, false);
    recordCueOutcome(store.db, false);
    recordCueOutcome(store.db, false);

    expect(readQueue(store.db, DEFAULTS, NOW).cueDegradedRate).toBe(0.25);
  });

  it('carries the reinforcement rows the cap threw away', () => {
    // A cap of one, so the second signal drops the first: the same trim a burst hits at 50,000.
    enqueueReinforcementSignal(store.db, 'a', 'b', 'recall', NOW.toISOString(), 1);
    enqueueReinforcementSignal(store.db, 'c', 'd', 'recall', NOW.toISOString(), 1);

    expect(readQueue(store.db, DEFAULTS, NOW).reinforcementDropped).toBe(1);
  });
});

describe('readGeneration', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-generation-health-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads a substrate that has generated nothing as unmeasured', () => {
    expect(readGeneration(store.db)).toEqual({ calls: 0, failed: 0, failureRate: undefined });
  });

  it('sums every route into the one rate a decision can be written against', () => {
    recordGenerationOutcome(store.db, {
      role: 'reflect',
      provider: 'anthropic',
      ok: false,
      durationMs: 800,
    });
    recordGenerationOutcome(store.db, {
      role: 'cue',
      provider: 'ollama',
      ok: true,
      durationMs: 300,
    });

    expect(readGeneration(store.db)).toEqual({ calls: 2, failed: 1, failureRate: 0.5 });
  });
});
