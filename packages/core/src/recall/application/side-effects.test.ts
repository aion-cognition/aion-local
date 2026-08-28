import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MemoryPack } from '@aion/protocol';
import type { Driver } from 'neo4j-driver';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asOf, knewAt, withCurrency } from '../../infrastructure/graph/read-modes.js';
import { openLogger, type Logger } from '../../infrastructure/logging/logger.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { listReinforcementSignals } from '../../infrastructure/sqlite/reinforcement-queue.js';
import type { ActivatedNode } from '../domain/activation.js';
import type { FusedItem } from '../domain/fusion.js';
import type { RecallCompletion } from './recall.js';
import {
  RecallSideEffects,
  REINFORCEMENT_TOP_N,
  REINFORCEMENT_TRIGGER,
  reinforcementPairs,
} from './side-effects.js';

const NOW = new Date('2026-08-27T12:00:00.000Z');

const EMPTY_PACK: MemoryPack = {
  rendered_text: 'irrelevant to these tests',
  metadata: {
    token_estimate: 1,
    stage_timings_ms: { embed: 0, cues: 0, seeds: 0, activation: 0, fusion: 0 },
    cues: [],
  },
};

function activatedNode(nodeId: string, score = 1, isStructural = false): ActivatedNode {
  return {
    nodeId,
    score,
    hops: 0,
    pathSummary: nodeId,
    currency: { currency: 'current' },
    isStructural,
  };
}

function fusedItem(id: string): FusedItem {
  return {
    id,
    labels: ['Episode', 'Memory'],
    content: `content for ${id}`,
    currency: 'current',
    rationale: { method: 'vector', score: 0.5 },
    relevance: 0.5,
    score: 0.5,
  };
}

function completion(overrides: Partial<RecallCompletion> = {}): RecallCompletion {
  return {
    sessionId: 'session-1',
    seeds: [],
    activated: [],
    items: [],
    pack: EMPTY_PACK,
    now: NOW,
    mode: withCurrency(),
    ...overrides,
  };
}

describe('reinforcementPairs', () => {
  it('produces nothing for fewer than two activated nodes', () => {
    expect(reinforcementPairs([])).toEqual([]);
    expect(reinforcementPairs([activatedNode('a')])).toEqual([]);
  });

  it('pairs every activated node with every other, in rank order', () => {
    const activated = [activatedNode('a', 0.9), activatedNode('b', 0.8), activatedNode('c', 0.7)];
    expect(reinforcementPairs(activated)).toEqual([
      ['a', 'b'],
      ['a', 'c'],
      ['b', 'c'],
    ]);
  });

  it('caps the fan-out at the top-N strongest activations', () => {
    const activated = Array.from({ length: REINFORCEMENT_TOP_N + 5 }, (_, index) =>
      activatedNode(`n${String(index)}`, 1 - index * 0.01),
    );
    const pairs = reinforcementPairs(activated);

    expect(pairs).toHaveLength((REINFORCEMENT_TOP_N * (REINFORCEMENT_TOP_N - 1)) / 2);
    const involved = new Set(pairs.flat());
    for (let index = REINFORCEMENT_TOP_N; index < activated.length; index += 1) {
      expect(involved.has(`n${String(index)}`)).toBe(false);
    }
  });

  it('leaves the backbone out of the fan-out entirely', () => {
    const pairs = reinforcementPairs([
      activatedNode('member', 1.7, true),
      activatedNode('workspace', 1.6, true),
      activatedNode('episode-a', 0.9),
      activatedNode('episode-b', 0.8),
    ]);

    expect(pairs).toEqual([['episode-a', 'episode-b']]);
  });

  it('does not spend the top-N budget on structural nodes', () => {
    const structural = Array.from({ length: REINFORCEMENT_TOP_N }, (_, index) =>
      activatedNode(`s${String(index)}`, 2 - index * 0.01, true),
    );
    const pairs = reinforcementPairs([...structural, activatedNode('a', 0.9), activatedNode('b', 0.8)]);

    expect(pairs).toEqual([['a', 'b']]);
  });
});

describe('RecallSideEffects', () => {
  let dir: string;
  let store: SqliteStore;
  let logger: Logger;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-side-effects-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
    logger = openLogger({ filePath: join(dir, 'aion.jsonl'), level: 'debug' });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function fakeDriver(calls: Array<Record<string, unknown>>, fail = false): Driver {
    return {
      executeQuery: (_cypher: string, parameters: Record<string, unknown>) => {
        calls.push(parameters);
        if (fail) {
          return Promise.reject(new Error('graph unreachable'));
        }
        return Promise.resolve({
          records: [],
          summary: {
            counters: { updates: () => ({ nodesCreated: 0, relationshipsCreated: 0, propertiesSet: 2 }) },
          },
        });
      },
    } as unknown as Driver;
  }

  it('enqueues one reinforcement row per co-activated pair, trigger naming the recall', () => {
    const sideEffects = new RecallSideEffects(fakeDriver([]), store.db, logger);
    sideEffects.onRecalled(
      completion({ activated: [activatedNode('a'), activatedNode('b'), activatedNode('c')] }),
    );

    const signals = listReinforcementSignals(store.db);
    expect(signals).toHaveLength(3);
    expect(signals.every((signal) => signal.trigger === REINFORCEMENT_TRIGGER)).toBe(true);
    expect(signals.every((signal) => signal.ts === NOW.toISOString())).toBe(true);
    expect(signals.map((signal) => [signal.sourceId, signal.targetId])).toEqual([
      ['a', 'b'],
      ['a', 'c'],
      ['b', 'c'],
    ]);
  });

  it('does not touch the graph until whenIdle is awaited', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const sideEffects = new RecallSideEffects(fakeDriver(calls), store.db, logger);

    sideEffects.onRecalled(completion({ items: [fusedItem('a'), fusedItem('b')] }));
    expect(calls).toHaveLength(0);

    await sideEffects.whenIdle();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.ids).toEqual(['a', 'b']);
  });

  it('dedupes surfaced ids from the fused item set', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const sideEffects = new RecallSideEffects(fakeDriver(calls), store.db, logger);

    sideEffects.onRecalled(completion({ items: [fusedItem('a'), fusedItem('a'), fusedItem('b')] }));
    await sideEffects.whenIdle();

    expect(calls[0]?.ids).toEqual(['a', 'b']);
  });

  it('schedules no write and resolves immediately when nothing surfaced', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const sideEffects = new RecallSideEffects(fakeDriver(calls), store.db, logger);

    sideEffects.onRecalled(completion({ items: [] }));
    await sideEffects.whenIdle();

    expect(calls).toHaveLength(0);
  });

  it('writes nothing at all on a time-travel recall', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const sideEffects = new RecallSideEffects(fakeDriver(calls), store.db, logger);
    const surfaced = {
      activated: [activatedNode('a'), activatedNode('b')],
      items: [fusedItem('a')],
    };

    sideEffects.onRecalled(completion({ ...surfaced, mode: asOf(new Date('2026-03-01T00:00:00.000Z')) }));
    sideEffects.onRecalled(completion({ ...surfaced, mode: knewAt(new Date('2026-03-01T00:00:00.000Z')) }));
    await sideEffects.whenIdle();

    expect(listReinforcementSignals(store.db)).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('logs and swallows a failing access-tracking write without throwing', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const sideEffects = new RecallSideEffects(fakeDriver(calls, true), store.db, logger);

    sideEffects.onRecalled(completion({ items: [fusedItem('a')] }));

    await expect(sideEffects.whenIdle()).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('keeps reinforcement enqueue and access-tracking independent: a closed db still lets the graph write proceed', async () => {
    const calls: Array<Record<string, unknown>> = [];
    store.close();
    const sideEffects = new RecallSideEffects(fakeDriver(calls), store.db, logger);

    sideEffects.onRecalled(
      completion({
        activated: [activatedNode('a'), activatedNode('b')],
        items: [fusedItem('a')],
      }),
    );
    await sideEffects.whenIdle();

    expect(calls).toHaveLength(1);
  });
});
