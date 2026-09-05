import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteStore } from './database.js';
import {
  appendDecaySweepEvent,
  appendReinforcementAppliedEvent,
  appendRecallAccessEvent,
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
