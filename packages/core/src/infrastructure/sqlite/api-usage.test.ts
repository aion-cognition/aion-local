import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appendApiCall, ApiUsageRecorder, summarizeApiCalls } from './api-usage.js';
import { SqliteStore, type SqliteHandle } from './database.js';
import { DEFAULTS } from '../config/defaults.js';
import { ProviderRouter } from '../providers/role-provider.js';
import type { ApiCall } from '../providers/types.js';

/**
 * Nothing in the package reads rows back: cost reporting only ever asks for the aggregate.
 * These tests are about what one call stored, so they read the rows here instead. Ordered by
 * insertion so identical timestamps still identify distinct requests.
 */
function storedApiCalls(db: SqliteHandle): (ApiCall & { readonly id: number })[] {
  const rows = db
    .prepare(
      `SELECT id, occurred_at AS occurredAt, model, surface,
    input_tokens AS inputTokens, output_tokens AS outputTokens,
    cache_creation_tokens AS cacheCreationTokens, cache_read_tokens AS cacheReadTokens,
    duration_ms AS durationMs, attempts, usage_error AS usageError
    FROM api_calls ORDER BY id`,
    )
    .all() as (Omit<ApiCall, 'occurredAt' | 'usageError'> & {
    id: number;
    occurredAt: string;
    usageError: NonNullable<ApiCall['usageError']> | null;
  })[];
  return rows.map(({ usageError, ...row }) => ({
    ...row,
    occurredAt: new Date(row.occurredAt),
    ...(usageError === null ? {} : { usageError }),
  }));
}

const CALL: ApiCall = {
  occurredAt: new Date('2026-09-06T10:00:00.000Z'),
  model: 'claude-haiku-4-5',
  surface: 'cues',
  inputTokens: 100,
  outputTokens: 20,
  cacheCreationTokens: 200,
  cacheReadTokens: 700,
  durationMs: 125,
  attempts: 2,
};

let store: SqliteStore;
beforeEach(() => {
  store = new SqliteStore({ filePath: ':memory:' });
});
afterEach(() => {
  if (store.db.open) {
    store.close();
  }
});

describe('the API call ledger', () => {
  it('receives keyed usage through the production router without metering local calls', async () => {
    const recorder = new ApiUsageRecorder(store.db, { warn: vi.fn(), error: vi.fn() });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: '{}' }],
          usage: { input_tokens: 12, output_tokens: 3 },
        }),
      ),
    );
    const keyed = new ProviderRouter({
      config: { ...DEFAULTS, anthropic: { ...DEFAULTS.anthropic, apiKey: 'test' } },
      fetchImpl,
      recordApiCall: recorder.recordApiCall,
    });
    await keyed.forRole('reflect').generate({
      model: DEFAULTS.models.reflect,
      surface: 'cognitive',
      messages: [{ role: 'user', content: 'test' }],
      schema: { type: 'object' },
    });
    expect(storedApiCalls(store.db)).toEqual([
      expect.objectContaining({
        model: DEFAULTS.anthropic.model,
        surface: 'cognitive',
        inputTokens: 12,
        outputTokens: 3,
      }),
    ]);
    fetchImpl.mockResolvedValue(new Response(JSON.stringify({ message: { content: '{}' } })));
    const local = new ProviderRouter({
      config: DEFAULTS,
      fetchImpl,
      recordApiCall: recorder.recordApiCall,
    });
    await local.forRole('cue').generate({
      model: DEFAULTS.models.cue,
      surface: 'cues',
      messages: [{ role: 'user', content: 'test' }],
      schema: { type: 'object' },
    });
    expect(storedApiCalls(store.db)).toHaveLength(1);
  });
  it('keeps repeated calls as separate rows with all usage fields intact', () => {
    appendApiCall(store.db, CALL);
    appendApiCall(store.db, CALL);
    expect(storedApiCalls(store.db)).toEqual([
      { id: 1, ...CALL },
      { id: 2, ...CALL },
    ]);
  });

  it('groups by UTC day and surface within a half-open date window', () => {
    appendApiCall(store.db, CALL);
    appendApiCall(store.db, { ...CALL, surface: 'cognitive' });
    appendApiCall(store.db, { ...CALL, occurredAt: new Date('2026-09-07T00:00:00Z') });
    appendApiCall(store.db, { ...CALL, occurredAt: new Date('2026-09-05T23:59:59Z') });
    const report = summarizeApiCalls(
      store.db,
      new Date('2026-09-06T00:00:00Z'),
      new Date('2026-09-07T00:00:00Z'),
    );
    expect(report.days).toEqual([
      {
        key: '2026-09-06',
        model: CALL.model,
        calls: 2,
        inputTokens: 200,
        outputTokens: 40,
        cacheCreationTokens: 400,
        cacheReadTokens: 1400,
        durationMs: 250,
        attempts: 4,
        usageErrors: 0,
      },
    ]);
    expect(report.surfaces.map((row) => [row.key, row.calls])).toEqual([
      ['cognitive', 1],
      ['cues', 1],
    ]);
  });

  it('reports a storage failure without failing generation or paying for it again', () => {
    const warn = vi.fn();
    const recorder = new ApiUsageRecorder(store.db, { warn, error: vi.fn() });
    store.close();
    expect(() => {
      recorder.recordApiCall(CALL);
    }).not.toThrow();
    expect(warn).toHaveBeenCalledOnce();
  });
});

it('records and error-logs invalid usage through the router without leaking response contents', async () => {
  const error = vi.fn();
  const recorder = new ApiUsageRecorder(store.db, { warn: vi.fn(), error });
  const router = new ProviderRouter({
    config: { ...DEFAULTS, anthropic: { ...DEFAULTS.anthropic, apiKey: 'test' } },
    recordApiCall: recorder.recordApiCall,
    fetchImpl: vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: '{}' }],
          usage: { input_tokens: 'private-response-value' },
        }),
      ),
    ),
  });
  await expect(
    router.forRole('reflect').generate({
      model: 'local',
      surface: 'cognitive',
      messages: [{ role: 'user', content: 'private-input' }],
      schema: { type: 'object' },
    }),
  ).resolves.toEqual({});
  expect(storedApiCalls(store.db)).toEqual([
    expect.objectContaining({ usageError: 'invalid_usage' }),
  ]);
  expect(error).toHaveBeenCalledExactlyOnceWith(
    { model: DEFAULTS.anthropic.model, surface: 'cognitive', usageError: 'invalid_usage' },
    'API usage parse failed; billed token counts are unknown',
  );
  expect(JSON.stringify(error.mock.calls)).not.toContain('private-');
  const report = summarizeApiCalls(store.db, new Date(0), new Date('2100-01-01'));
  expect(report.days[0]?.usageErrors).toBe(1);
  expect(report.surfaces[0]?.usageErrors).toBe(1);
});
