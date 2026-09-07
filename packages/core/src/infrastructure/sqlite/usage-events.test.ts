import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteStore } from './database.js';
import {
  appendDecaySweepEvent,
  appendMemoryConfirmedEvent,
  appendPackEmittedEvent,
  appendReinforcementAppliedEvent,
  appendRecallAccessEvent,
  appendSelfReportEvent,
  listUsageEventsAfter,
  type UsageEventCursor,
} from './usage-events.js';

const OCCURRED_AT = new Date('2026-03-01T10:00:00.000Z');
const RECORDED_AT = new Date('2026-03-01T10:00:01.000Z');

let dir: string;
let store: SqliteStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-usage-events-'));
  store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('usage event storage', () => {
  it('creates the table with exactly the columns the schema declares', () => {
    const columns = (store.db.pragma('table_info(usage_events)') as { name: string }[]).map(
      (column) => column.name,
    );

    expect(columns).toEqual(['id', 'kind', 'payload_json', 'occurred_at', 'recorded_at']);
  });

  it('appends the node ids one recall bumped, at the recall clock', () => {
    appendRecallAccessEvent(store.db, {
      ids: ['node-b', 'node-a'],
      occurredAt: OCCURRED_AT,
      recordedAt: RECORDED_AT,
    });

    expect(listUsageEventsAfter(store.db, undefined, 10)).toEqual([
      {
        id: 1,
        kind: 'recall_access',
        payload: { ids: ['node-b', 'node-a'] },
        occurredAt: OCCURRED_AT.toISOString(),
        recordedAt: RECORDED_AT.toISOString(),
      },
    ]);
  });

  it('appends one flush window with its pairs, its triggers and the floor it applied under', () => {
    appendReinforcementAppliedEvent(store.db, {
      pairs: [{ sourceId: 'a', targetId: 'b', learningRate: 0.05 }],
      triggers: ['recall_co_activation'],
      weightFloor: 0.1,
      occurredAt: OCCURRED_AT,
      recordedAt: RECORDED_AT,
    });

    const [event] = listUsageEventsAfter(store.db, undefined, 10);

    expect(event?.kind).toBe('reinforcement_applied');
    expect(event?.payload).toEqual({
      pairs: [{ sourceId: 'a', targetId: 'b', learningRate: 0.05 }],
      triggers: ['recall_co_activation'],
      weightFloor: 0.1,
    });
  });

  it('appends one row per sweep carrying the parameters the scan ran under', () => {
    appendDecaySweepEvent(store.db, {
      batchSize: 200,
      decayRate: 0.02,
      peakDays: 30,
      sigma: 12,
      weightFloor: 0.1,
      occurredAt: OCCURRED_AT,
      recordedAt: RECORDED_AT,
    });

    const [event] = listUsageEventsAfter(store.db, undefined, 10);

    expect(event?.kind).toBe('decay_sweep');
    expect(event?.payload).toEqual({
      batchSize: 200,
      decayRate: 0.02,
      peakDays: 30,
      sigma: 12,
      weightFloor: 0.1,
    });
  });

  it('stamps the wall clock itself when the caller names no recording moment', () => {
    const before = Date.now();
    appendRecallAccessEvent(store.db, { ids: ['node-a'], occurredAt: OCCURRED_AT });

    const [event] = listUsageEventsAfter(store.db, undefined, 10);

    expect(Date.parse(event?.recordedAt ?? '')).toBeGreaterThanOrEqual(before);
  });

  it('pages by keyset over (occurred_at, id), oldest first, with no gap and no repeat', () => {
    for (let minute = 0; minute < 5; minute += 1) {
      appendRecallAccessEvent(store.db, {
        ids: [`node-${String(minute)}`],
        occurredAt: new Date(`2026-03-01T10:0${String(minute)}:00.000Z`),
        recordedAt: RECORDED_AT,
      });
    }

    const seen: string[] = [];
    let cursor: UsageEventCursor | undefined;
    for (;;) {
      const page = listUsageEventsAfter(store.db, cursor, 2);
      if (page.length === 0) {
        break;
      }
      for (const event of page) {
        seen.push(event.occurredAt);
      }
      const last = page[page.length - 1]!;
      cursor = { occurredAt: last.occurredAt, id: last.id };
    }

    expect(seen).toEqual([
      '2026-03-01T10:00:00.000Z',
      '2026-03-01T10:01:00.000Z',
      '2026-03-01T10:02:00.000Z',
      '2026-03-01T10:03:00.000Z',
      '2026-03-01T10:04:00.000Z',
    ]);
  });

  it('orders two events stamped at the same moment by the id that recorded them', () => {
    appendRecallAccessEvent(store.db, { ids: ['first'], occurredAt: OCCURRED_AT });
    appendRecallAccessEvent(store.db, { ids: ['second'], occurredAt: OCCURRED_AT });

    const ids = listUsageEventsAfter(store.db, undefined, 10).map((event) => event.id);

    expect(ids).toEqual([1, 2]);
  });

  it('hands out a fresh id for every append, so a cursor never revisits a step', () => {
    appendRecallAccessEvent(store.db, { ids: ['a'], occurredAt: OCCURRED_AT });
    appendDecaySweepEvent(store.db, {
      batchSize: 1,
      decayRate: 0.02,
      peakDays: 30,
      sigma: 12,
      weightFloor: 0.1,
      occurredAt: OCCURRED_AT,
    });

    const ids = listUsageEventsAfter(store.db, undefined, 10).map((event) => event.id);

    expect(new Set(ids).size).toBe(2);
  });

  it('appends what one recall emitted apart from what it retrieved', () => {
    appendPackEmittedEvent(store.db, {
      sessionId: 'session-1',
      ids: ['served'],
      retrieved: ['served', 'cut'],
      occurredAt: OCCURRED_AT,
      recordedAt: RECORDED_AT,
    });

    const [event] = listUsageEventsAfter(store.db, undefined, 10);

    expect(event?.kind).toBe('pack_emitted');
    expect(event?.payload).toEqual({
      sessionId: 'session-1',
      ids: ['served'],
      retrieved: ['served', 'cut'],
    });
  });
});

describe('the signals nobody can read off the graph', () => {
  const REPORT = {
    sessionId: 'session-1',
    memories: ['node-a'],
    reporter: 'the calling agent',
    evidence: 'turn 12',
    occurredAt: OCCURRED_AT,
    recordedAt: RECORDED_AT,
  };

  it('keeps receipt and use apart rather than folding them into one signal', () => {
    appendSelfReportEvent(store.db, 'delivery_acknowledged', { ...REPORT, key: 'received-1' });
    appendSelfReportEvent(store.db, 'memory_used', { ...REPORT, key: 'used-1' });

    expect(listUsageEventsAfter(store.db, undefined, 10).map((event) => event.kind)).toEqual([
      'delivery_acknowledged',
      'memory_used',
    ]);
  });

  it('records a report once however many times it is stated', () => {
    expect(appendSelfReportEvent(store.db, 'memory_used', { ...REPORT, key: 'used-1' })).toBe(true);
    expect(appendSelfReportEvent(store.db, 'memory_used', { ...REPORT, key: 'used-1' })).toBe(
      false,
    );
    expect(
      appendSelfReportEvent(store.db, 'memory_used', {
        ...REPORT,
        key: 'used-1',
        occurredAt: new Date('2026-04-01T10:00:00.000Z'),
      }),
    ).toBe(false);

    expect(listUsageEventsAfter(store.db, undefined, 10)).toHaveLength(1);
  });

  it('takes a second report of the same kind under its own name', () => {
    appendSelfReportEvent(store.db, 'memory_used', { ...REPORT, key: 'used-1' });
    appendSelfReportEvent(store.db, 'memory_used', {
      ...REPORT,
      key: 'used-2',
      memories: ['node-b'],
    });

    expect(listUsageEventsAfter(store.db, undefined, 10)).toHaveLength(2);
  });

  it('omits the evidence field entirely when the reporter cited nothing', () => {
    appendSelfReportEvent(store.db, 'memory_used', {
      sessionId: 'session-1',
      memories: ['node-a'],
      reporter: 'the calling agent',
      key: 'used-1',
      occurredAt: OCCURRED_AT,
    });

    expect(listUsageEventsAfter(store.db, undefined, 10)[0]?.payload).toEqual({
      sessionId: 'session-1',
      memories: ['node-a'],
      reporter: 'the calling agent',
    });
  });

  /** A confirmation names a confirmer and cites where it is written down, which a report need not. */
  it('carries a confirmation with the reference that makes it attributable', () => {
    appendMemoryConfirmedEvent(store.db, {
      key: 'confirmed-1',
      episodeId: 'episode-1',
      memories: ['node-a'],
      confirmedBy: 'Ryan Huber',
      evidence: 'review thread 41',
      occurredAt: OCCURRED_AT,
      recordedAt: RECORDED_AT,
    });

    expect(listUsageEventsAfter(store.db, undefined, 10)[0]).toEqual({
      id: 1,
      kind: 'memory_confirmed',
      payload: {
        episodeId: 'episode-1',
        memories: ['node-a'],
        confirmedBy: 'Ryan Huber',
        evidence: 'review thread 41',
      },
      occurredAt: OCCURRED_AT.toISOString(),
      recordedAt: RECORDED_AT.toISOString(),
    });
  });

  it('records a confirmation once however many times the same experience re-states it', () => {
    const event = {
      key: 'confirmed-1',
      episodeId: 'episode-1',
      memories: ['node-a'],
      confirmedBy: 'Ryan Huber',
      evidence: 'review thread 41',
      occurredAt: OCCURRED_AT,
    };

    expect(appendMemoryConfirmedEvent(store.db, event)).toBe(true);
    expect(appendMemoryConfirmedEvent(store.db, event)).toBe(false);
    expect(listUsageEventsAfter(store.db, undefined, 10)).toHaveLength(1);
  });
});

describe('usage event storage, continued', () => {
  it('writes no statement that could change or drop a row it already recorded', () => {
    const source = readFileSync(fileURLToPath(new URL('usage-events.ts', import.meta.url)), 'utf8');
    // Prose names the two statements the module forbids, and prose is not a statement.
    const statements = source
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

    expect(statements).not.toMatch(/\bUPDATE\b/i);
    expect(statements).not.toMatch(/\bDELETE\b/i);
  });
});
