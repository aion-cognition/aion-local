import { RecallMethodSchema } from '@aion/protocol';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteStore } from './database.js';
import {
  PACK_METHODS,
  packMethodCounters,
  packMethodLegStats,
  recordPackMethodCounts,
  recordPackMethodLegStats,
} from './method-counters.js';

describe('pack method counters', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-method-counters-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('counts only methods an item can actually carry', () => {
    const protocolMethods = new Set<string>(RecallMethodSchema.options);
    for (const method of PACK_METHODS) {
      expect(protocolMethods.has(method)).toBe(true);
    }
    // The one the protocol names and no item carries: `graph_traversal` is the fusion leg,
    // and the items it produces are scored and labelled by the activation stage.
    const counted = new Set<string>(PACK_METHODS);
    expect([...RecallMethodSchema.options].filter((method) => !counted.has(method))).toEqual([
      'graph_traversal',
    ]);
  });

  it('starts every method at zero', () => {
    expect(packMethodCounters(store.db)).toEqual({
      vector: 0,
      bm25: 0,
      activation: 0,
      resonance: 0,
      entity_resolution: 0,
      recency: 0,
    });
  });

  it('counts one item per method in the list handed to it', () => {
    recordPackMethodCounts(store.db, ['vector', 'vector', 'activation']);

    const counters = packMethodCounters(store.db);
    expect(counters.vector).toBe(2);
    expect(counters.activation).toBe(1);
    expect(counters.bm25).toBe(0);
  });

  it('accumulates across separate calls rather than resetting each time', () => {
    recordPackMethodCounts(store.db, ['vector']);
    recordPackMethodCounts(store.db, ['vector', 'resonance']);

    const counters = packMethodCounters(store.db);
    expect(counters.vector).toBe(2);
    expect(counters.resonance).toBe(1);
  });

  it('does nothing for an empty pack', () => {
    recordPackMethodCounts(store.db, []);

    expect(Object.values(packMethodCounters(store.db)).every((count) => count === 0)).toBe(true);
  });
});

describe('pack method leg stats', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-method-leg-stats-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts every method at zero', () => {
    const stats = packMethodLegStats(store.db);
    for (const method of PACK_METHODS) {
      expect(stats[method]).toEqual({ sole: 0, shared: 0, rrfContribution: 0 });
    }
  });

  it('records what one pack found, leaving an unmentioned method at zero', () => {
    recordPackMethodLegStats(store.db, {
      vector: { sole: 2, shared: 1, rrfContribution: 0.5 },
      activation: { sole: 0, shared: 1, rrfContribution: 0.2 },
    });

    const stats = packMethodLegStats(store.db);
    expect(stats.vector).toEqual({ sole: 2, shared: 1, rrfContribution: 0.5 });
    expect(stats.activation).toEqual({ sole: 0, shared: 1, rrfContribution: 0.2 });
    expect(stats.bm25).toEqual({ sole: 0, shared: 0, rrfContribution: 0 });
  });

  it('accumulates across separate packs rather than overwriting the running total', () => {
    recordPackMethodLegStats(store.db, { vector: { sole: 1, shared: 0, rrfContribution: 0.1 } });
    recordPackMethodLegStats(store.db, { vector: { sole: 1, shared: 1, rrfContribution: 0.2 } });

    const { vector } = packMethodLegStats(store.db);
    expect(vector.sole).toBe(2);
    expect(vector.shared).toBe(1);
    expect(vector.rrfContribution).toBeCloseTo(0.3, 10);
  });

  it('does nothing for a pack that credited no method', () => {
    recordPackMethodLegStats(store.db, {});

    const stats = packMethodLegStats(store.db);
    for (const method of PACK_METHODS) {
      expect(stats[method]).toEqual({ sole: 0, shared: 0, rrfContribution: 0 });
    }
  });
});
