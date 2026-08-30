import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecallMethodSchema } from '@aion/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStore } from './database.js';
import { PACK_METHODS, packMethodCounters, recordPackMethodCounts } from './method-counters.js';

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
    expect([...RecallMethodSchema.options].filter((method) => !PACK_METHODS.includes(method))).toEqual([
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
