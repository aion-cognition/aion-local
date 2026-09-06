import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appendApiCall, ApiUsageRecorder, listApiCalls, summarizeApiCalls } from './api-usage.js';
import { SqliteStore } from './database.js';
import { DEFAULTS } from '../config/defaults.js';
import { ProviderRouter } from '../providers/role-provider.js';
import type { ApiCall } from '../providers/types.js';

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
    const recorder = new ApiUsageRecorder(store.db, { warn: vi.fn() });
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
    expect(listApiCalls(store.db)).toEqual([
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
    expect(listApiCalls(store.db)).toHaveLength(1);
  });
  it('keeps repeated calls as separate rows with all usage fields intact', () => {
    appendApiCall(store.db, CALL);
    appendApiCall(store.db, CALL);
    expect(listApiCalls(store.db)).toEqual([
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
      },
    ]);
    expect(report.surfaces.map((row) => [row.key, row.calls])).toEqual([
      ['cognitive', 1],
      ['cues', 1],
    ]);
  });

  it('reports a storage failure without failing generation or paying for it again', () => {
    const warn = vi.fn();
    const recorder = new ApiUsageRecorder(store.db, { warn });
    store.close();
    expect(() => {
      recorder.recordApiCall(CALL);
    }).not.toThrow();
    expect(warn).toHaveBeenCalledOnce();
  });
});
