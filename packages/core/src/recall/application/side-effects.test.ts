import type { MemoryPack } from '@aion/protocol';
import type { Driver } from 'neo4j-driver';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RecallCompletion } from './recall.js';
import {
  RecallSideEffects,
  REINFORCEMENT_TOP_N,
  REINFORCEMENT_TRIGGER,
  reinforcementPairs,
} from './side-effects.js';
import { asOf, knewAt, withCurrency } from '../../infrastructure/graph/read-modes.js';
import { openLogger, type Logger } from '../../infrastructure/logging/logger.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { listReinforcementSignals } from '../../infrastructure/sqlite/reinforcement-queue.js';
import { listUsageEventsAfter } from '../../infrastructure/sqlite/usage-events.js';
import type { ActivatedNode } from '../domain/activation.js';
import type { AdmissionReport } from '../domain/admission.js';
import { emittedPackIds } from '../domain/session-dedup.js';
import { assemble, item as packItem } from '../domain/test-support/pack.fixture.js';

const NOW = new Date('2026-08-27T12:00:00.000Z');

const EMPTY_PACK: MemoryPack = {
  rendered_text: 'irrelevant to these tests',
  metadata: {
    token_estimate: 1,
    stage_timings_ms: { embed: 0, cues: 0, seeds: 0, activation: 0, fusion: 0 },
    cues: [],
    admission: {
      considered: 0,
      admitted: 0,
      dropped_below_floor: 0,
      dropped_unmeasured: 0,
      dropped_unmeasured_arrival: 0,
      dropped_duplicate_content: 0,
      dropped_near_duplicate: 0,
      vector_floor: 0.6,
      corroboration_floor: 0.45,
      bm25_mode: 'exact',
    },
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

/** The gate's own report for a recall that fused nothing; side effects never read it. */
const NOTHING_ADMITTED: AdmissionReport = {
  policy: { vectorFloor: 0.5, corroborationFloor: 0.45, bm25Mode: 'exact' },
  considered: 0,
  admitted: 0,
  droppedBelowFloor: 0,
  droppedUnmeasured: 0,
  droppedUnmeasuredArrival: 0,
  droppedDuplicateContent: 0,
  droppedNearDuplicate: 0,
  anchored: false,
  typedAdmitted: 0,
};

function completion(overrides: Partial<RecallCompletion> = {}): RecallCompletion {
  return {
    sessionId: 'session-1',
    seeds: [],
    activated: [],
    retrieved: [],
    emitted: new Set(),
    admission: NOTHING_ADMITTED,
    pack: EMPTY_PACK,
    now: NOW,
    mode: withCurrency(),
    ...overrides,
  };
}

/** A recall that served everything it ranked, which is the shape most of these tests want. */
function served(...ids: readonly string[]): Partial<RecallCompletion> {
  return { retrieved: [...ids], emitted: new Set(ids) };
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
    const pairs = reinforcementPairs([
      ...structural,
      activatedNode('a', 0.9),
      activatedNode('b', 0.8),
    ]);

    expect(pairs).toEqual([['a', 'b']]);
  });
});

describe('RecallSideEffects', () => {
  let dir: string;
  let store: SqliteStore;
  let logger: Logger;

  type LogLine = {
    readonly msg: string;
    readonly sessionId?: string;
    readonly activated?: number;
    readonly items?: number;
  };

  function loggedWarning(msg: string): LogLine | undefined {
    return readFileSync(join(dir, 'aion.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as LogLine)
      .find((line) => line.msg === msg);
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-side-effects-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
    logger = openLogger({ filePath: join(dir, 'aion.jsonl'), level: 'debug' });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function fakeDriver(calls: Record<string, unknown>[], fail = false): Driver {
    return {
      executeQuery: (_cypher: string, parameters: Record<string, unknown>) => {
        calls.push(parameters);
        if (fail) {
          return Promise.reject(new Error('graph unreachable'));
        }
        return Promise.resolve({
          records: [],
          summary: {
            counters: {
              updates: () => ({ nodesCreated: 0, relationshipsCreated: 0, propertiesSet: 2 }),
            },
          },
        });
      },
    } as unknown as Driver;
  }

  it('enqueues one reinforcement row per served pair, trigger naming the recall', () => {
    const sideEffects = new RecallSideEffects(fakeDriver([]), store.db, logger);
    void sideEffects.onRecalled(
      completion({
        activated: [activatedNode('a'), activatedNode('b'), activatedNode('c')],
        ...served('a', 'b', 'c'),
      }),
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

  /**
   * A node the spread reached and the pack never carried is a fact about this query. Pairing it
   * teaches the graph that a search ran, which is the thing exposure is supposed to be about.
   */
  it('pairs only the nodes the pack handed over', () => {
    const sideEffects = new RecallSideEffects(fakeDriver([]), store.db, logger);
    void sideEffects.onRecalled(
      completion({
        activated: [activatedNode('a'), activatedNode('cut'), activatedNode('b')],
        retrieved: ['a', 'cut', 'b'],
        emitted: new Set(['a', 'b']),
      }),
    );

    expect(
      listReinforcementSignals(store.db).map((signal) => [signal.sourceId, signal.targetId]),
    ).toEqual([['a', 'b']]);
  });

  it('enqueues nothing when the pack handed over one memory, since one memory pairs with none', () => {
    const sideEffects = new RecallSideEffects(fakeDriver([]), store.db, logger);
    void sideEffects.onRecalled(
      completion({
        activated: [activatedNode('a'), activatedNode('b')],
        retrieved: ['a', 'b'],
        emitted: new Set(['a']),
      }),
    );

    expect(listReinforcementSignals(store.db)).toEqual([]);
  });

  /**
   * A pack that printed nothing put nothing in front of anybody. The session read both of these
   * on the recall that did print them, and reading them once is one exposure.
   */
  it('charges no exposure when every candidate was withheld as a repeat', async () => {
    const calls: Record<string, unknown>[] = [];
    const sideEffects = new RecallSideEffects(fakeDriver(calls), store.db, logger);
    const suppressed = new Set(['a', 'b']);
    const pack = assemble([packItem('a'), packItem('b')], { suppressed });
    expect(pack.episodes).toBeUndefined();

    void sideEffects.onRecalled(
      completion({
        pack,
        activated: [activatedNode('a'), activatedNode('b')],
        retrieved: ['a', 'b'],
        emitted: emittedPackIds(pack),
      }),
    );
    await sideEffects.whenIdle();

    expect(listReinforcementSignals(store.db)).toEqual([]);
    expect(calls).toEqual([]);
    expect(listUsageEventsAfter(store.db, undefined, 10)).toMatchObject([
      { kind: 'pack_emitted', payload: { ids: [], retrieved: ['a', 'b'] } },
    ]);
  });

  it('does not touch the graph until whenIdle is awaited', async () => {
    const calls: Record<string, unknown>[] = [];
    const sideEffects = new RecallSideEffects(fakeDriver(calls), store.db, logger);

    void sideEffects.onRecalled(completion(served('a', 'b')));
    expect(calls).toHaveLength(0);

    await sideEffects.whenIdle();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.ids).toEqual(['a', 'b']);
  });

  /**
   * `last_accessed` is what the recency seed strategy reads back, so stamping a memory the wire
   * never carried makes the next recall prefer something nobody has been shown.
   */
  it('stamps only what the pack handed over, not everything fusion ranked', async () => {
    const calls: Record<string, unknown>[] = [];
    const sideEffects = new RecallSideEffects(fakeDriver(calls), store.db, logger);

    void sideEffects.onRecalled(
      completion({
        retrieved: ['a', 'budget-cut', 'b'],
        emitted: new Set(['a', 'b']),
      }),
    );
    await sideEffects.whenIdle();

    expect(calls[0]?.ids).toEqual(['a', 'b']);
  });

  it('schedules no write and resolves immediately when nothing reached the pack', async () => {
    const calls: Record<string, unknown>[] = [];
    const sideEffects = new RecallSideEffects(fakeDriver(calls), store.db, logger);

    void sideEffects.onRecalled(completion({ retrieved: ['refused'], emitted: new Set() }));
    await sideEffects.whenIdle();

    expect(calls).toHaveLength(0);
  });

  it('writes nothing at all on a time-travel recall', async () => {
    const calls: Record<string, unknown>[] = [];
    const sideEffects = new RecallSideEffects(fakeDriver(calls), store.db, logger);
    const surfaced = {
      activated: [activatedNode('a'), activatedNode('b')],
      ...served('a', 'b'),
    };

    void sideEffects.onRecalled(
      completion({ ...surfaced, mode: asOf(new Date('2026-03-01T00:00:00.000Z')) }),
    );
    void sideEffects.onRecalled(
      completion({ ...surfaced, mode: knewAt(new Date('2026-03-01T00:00:00.000Z')) }),
    );
    await sideEffects.whenIdle();

    expect(listReinforcementSignals(store.db)).toEqual([]);
    expect(listUsageEventsAfter(store.db, undefined, 10)).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('logs and swallows a failing access-tracking write without throwing', async () => {
    const calls: Record<string, unknown>[] = [];
    const sideEffects = new RecallSideEffects(fakeDriver(calls, true), store.db, logger);

    void sideEffects.onRecalled(completion(served('a', 'b')));

    await expect(sideEffects.whenIdle()).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    // Which recall lost its access stamps, and how many, since `{ err }` alone named neither.
    expect(loggedWarning('recall access-tracking write failed')).toMatchObject({
      sessionId: 'session-1',
      items: 2,
    });
  });

  it('keeps reinforcement enqueue and access-tracking independent: a closed db still lets the graph write proceed', async () => {
    const calls: Record<string, unknown>[] = [];
    store.close();
    const sideEffects = new RecallSideEffects(fakeDriver(calls), store.db, logger);

    void sideEffects.onRecalled(
      completion({
        activated: [activatedNode('a'), activatedNode('b')],
        ...served('a', 'b'),
      }),
    );
    await sideEffects.whenIdle();

    expect(calls).toHaveLength(1);
    expect(loggedWarning('recall pack-emitted append failed')).toBeDefined();
    expect(loggedWarning('recall reinforcement enqueue failed')).toMatchObject({
      sessionId: 'session-1',
      activated: 2,
    });
  });
});

describe('what a recall emitted, recorded apart from what it retrieved', () => {
  let dir: string;
  let store: SqliteStore;
  let logger: Logger;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-pack-emitted-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
    logger = openLogger({ filePath: join(dir, 'aion.jsonl'), level: 'debug' });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function driver(calls: Record<string, unknown>[] = []): Driver {
    return {
      executeQuery: (_cypher: string, parameters: Record<string, unknown>) => {
        calls.push(parameters);
        return Promise.resolve({
          records: [],
          summary: { counters: { updates: () => ({ propertiesSet: 0 }) } },
        });
      },
    } as unknown as Driver;
  }

  /**
   * The row is written before the graph write it precedes and never waits on it, so what the
   * caller was handed is recorded whether or not the access bump behind it lands.
   */
  it('records both populations inline, before the deferred graph write', () => {
    const sideEffects = new RecallSideEffects(driver(), store.db, logger);

    void sideEffects.onRecalled(
      completion({
        retrieved: ['a', 'cut', 'b'],
        emitted: new Set(['a', 'b']),
      }),
    );

    expect(listUsageEventsAfter(store.db, undefined, 10)).toEqual([
      {
        id: 1,
        kind: 'pack_emitted',
        payload: { sessionId: 'session-1', ids: ['a', 'b'], retrieved: ['a', 'cut', 'b'] },
        occurredAt: NOW.toISOString(),
        recordedAt: expect.any(String),
      },
    ]);
  });

  it('records an emission of nothing rather than staying silent about a pack that served none', () => {
    const sideEffects = new RecallSideEffects(driver(), store.db, logger);

    void sideEffects.onRecalled(completion({ retrieved: ['refused'] }));

    expect(listUsageEventsAfter(store.db, undefined, 10)).toMatchObject([
      { kind: 'pack_emitted', payload: { ids: [], retrieved: ['refused'] } },
    ]);
  });

  /**
   * Resonance and the intention triggers offer candidates fusion never saw. A record that counted
   * only the first pass would show memories emitted that it never retrieved, and would say
   * nothing at all about what the second and third passes lost to a cap.
   */
  it('counts the second and third passes as retrieved, and only what printed as emitted', async () => {
    const calls: Record<string, unknown>[] = [];
    const sideEffects = new RecallSideEffects(driver(calls), store.db, logger);

    void sideEffects.onRecalled(
      completion({
        retrieved: ['fused', 'resonant-served', 'resonant-cut'],
        emitted: new Set(['fused', 'resonant-served']),
      }),
    );
    await sideEffects.whenIdle();

    const emitted = listUsageEventsAfter(store.db, undefined, 10).filter(
      (event) => event.kind === 'pack_emitted',
    );
    expect(emitted).toMatchObject([
      {
        payload: {
          ids: ['fused', 'resonant-served'],
          retrieved: ['fused', 'resonant-served', 'resonant-cut'],
        },
      },
    ]);
    expect(calls[0]?.ids).toEqual(['fused', 'resonant-served']);
  });
});
