import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildBatchCadenceReport, describeBatchCadenceReport } from './batch-cadence-report.js';
import { appendApiCall } from '../../../infrastructure/sqlite/api-usage.js';
import {
  enqueueBatchWork,
  markBatchSubmitted,
  settleBatchWork,
} from '../../../infrastructure/sqlite/batch-work.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';

const SINCE = new Date('2026-09-01T00:00:00.000Z');
const UNTIL = new Date('2026-09-02T00:00:00.000Z');

let db: SqliteHandle;

beforeEach(() => {
  db = openSqliteHandle({ filePath: ':memory:' });
});

afterEach(() => {
  db.close();
});

describe('the batch-cadence report', () => {
  it('reports an empty population as a valid result, not a zero latency', () => {
    const report = buildBatchCadenceReport(db, SINCE, UNTIL);

    expect(report.settledSamples).toEqual([]);
    expect(report.medianObservedLatencyMs).toBeUndefined();
    expect(report.metredCalls).toBe(0);
    const lines = describeBatchCadenceReport(report);
    expect(lines.join('\n')).toContain('no batch item settled');
    expect(lines.join('\n')).toContain('no metered API call');
    expect(lines.join('\n')).toContain('not evidence of zero latency or perfect caching');
  });

  it('measures observed submit-to-settle latency and cache usage from real rows', () => {
    enqueueBatchWork(db, {
      workKey: 'w1',
      substrateId: 'sub-1',
      surface: 'synthesis',
      revalidation: {},
      request: {},
      now: new Date('2026-09-01T12:00:00.000Z'),
    });
    markBatchSubmitted(db, ['w1'], 'batch-1', new Date('2026-09-01T12:00:00.000Z'));
    settleBatchWork(db, 'w1', 'applied', undefined, new Date('2026-09-01T12:05:00.000Z'));

    appendApiCall(db, {
      occurredAt: new Date('2026-09-01T12:05:00.000Z'),
      model: 'claude-haiku-4-5',
      surface: 'synthesis',
      inputTokens: 1000,
      outputTokens: 200,
      cacheCreationTokens: 0,
      cacheReadTokens: 400,
      durationMs: 500,
      attempts: 1,
    });

    const report = buildBatchCadenceReport(db, SINCE, UNTIL);

    expect(report.settledSamples).toHaveLength(1);
    expect(report.settledSamples[0]?.observedLatencyMs).toBe(5 * 60 * 1000);
    expect(report.medianObservedLatencyMs).toBe(5 * 60 * 1000);
    expect(report.cacheReadTokens).toBe(400);
    expect(report.inputTokens).toBe(1000);
    const lines = describeBatchCadenceReport(report);
    expect(lines.join('\n')).toContain('1 settled item(s)');
    // 400 cache reads over the 1,400 input tokens of all three classes. The API's
    // `input_tokens` excludes cache reads and writes, so dividing by it alone overstated the
    // share (and reported 900% for 90 cached against 10 uncached).
    expect(lines.join('\n')).toContain('28.6% served from cache');
  });
});
