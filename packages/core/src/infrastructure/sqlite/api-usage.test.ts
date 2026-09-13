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
    thinking_tokens AS thinkingTokens,
    duration_ms AS durationMs, attempts, usage_error AS usageError
    FROM api_calls ORDER BY id`,
    )
    .all() as (Omit<ApiCall, 'occurredAt' | 'usageError' | 'thinkingTokens'> & {
    id: number;
    occurredAt: string;
    usageError: NonNullable<ApiCall['usageError']> | null;
    thinkingTokens: number | null;
  })[];
  // Both nullable columns come back absent rather than null, which is how an `ApiCall` states
  // the same two facts: no parse failure, and no reported reasoning share.
  return rows.map(({ usageError, thinkingTokens, ...row }) => ({
    ...row,
    occurredAt: new Date(row.occurredAt),
    ...(usageError === null ? {} : { usageError }),
    ...(thinkingTokens === null ? {} : { thinkingTokens }),
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
  thinkingTokens: 0,
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
  it('receives usage through the production router, and nothing at all with no key', async () => {
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
      model: DEFAULTS.anthropic.model,
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
    // A substrate with no key never reaches a billed endpoint, so the ledger stays as it was.
    const keyless = new ProviderRouter({
      config: DEFAULTS,
      fetchImpl,
      recordApiCall: recorder.recordApiCall,
    });
    await expect(
      keyless.forRole('cue').generate({
        model: DEFAULTS.anthropic.model,
        surface: 'cues',
        messages: [{ role: 'user', content: 'test' }],
        schema: { type: 'object' },
      }),
    ).rejects.toThrow();
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

  it('records one charge per remote request however often that request is read back', () => {
    const batched = { ...CALL, requestId: 'msgbatch_1:pair-a', pricingTier: 'batch' as const };

    expect(appendApiCall(store.db, batched)).toBe(true);
    // The second reading is the same paid response, handed over again by a settlement pass that
    // found the batch still holding rows.
    expect(appendApiCall(store.db, batched)).toBe(false);

    const bill = summarizeApiCalls(
      store.db,
      new Date('2026-09-06T00:00:00Z'),
      new Date('2026-09-07T00:00:00Z'),
    );
    expect(bill.days.map((row) => [row.calls, row.pricingTier])).toEqual([[1, 'batch']]);
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
        // A call that named no rate card billed on the ordinary one, which is what every
        // synchronous call does.
        pricingTier: 'standard',
        calls: 2,
        inputTokens: 200,
        outputTokens: 40,
        cacheCreationTokens: 400,
        cacheReadTokens: 1400,
        thinkingTokens: 0,
        thinkingUnknown: 0,
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

  /**
   * A response whose usage block carried no breakdown is fully billed and partly unexplained.
   * The row holds the totals and leaves the reasoning share out, and the aggregate says how many
   * of its calls did that rather than folding them in at zero.
   */
  it('stores an unreported reasoning share as unknown rather than as none', () => {
    const { thinkingTokens: reported, ...unreported } = CALL;
    appendApiCall(store.db, unreported);
    expect(storedApiCalls(store.db)).toEqual([{ id: 1, ...unreported }]);
    expect(storedApiCalls(store.db)[0]).not.toHaveProperty('thinkingTokens');

    const onlyUnknown = summarizeApiCalls(store.db, new Date(0), new Date('2100-01-01'));
    expect(onlyUnknown.days[0]).toMatchObject({
      outputTokens: 20,
      thinkingTokens: null,
      thinkingUnknown: 1,
    });

    // A reported zero is a fact and sums as one, which is the distinction the two columns keep.
    appendApiCall(store.db, { ...unreported, thinkingTokens: reported });
    const mixed = summarizeApiCalls(store.db, new Date(0), new Date('2100-01-01'));
    expect(mixed.days[0]).toMatchObject({ thinkingTokens: 0, thinkingUnknown: 1 });
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
