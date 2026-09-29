import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { batchMessagesBody } from './anthropic-provider.js';
import { readUsage } from './anthropic-usage.js';
import { estimateApiCost } from './api-pricing.js';
import { submitBatchWork, type BatchAdapterDeps } from './batch-adapter.js';
import { GenerationSpendGuard, type SpendHoldRequest } from './spending.js';
import type { ApiCall } from './types.js';
import { appendApiCall, chargedApiUsd, summarizeApiCalls } from '../sqlite/api-usage.js';
import { enqueueBatchWork } from '../sqlite/batch-work.js';
import { SqliteStore } from '../sqlite/database.js';

const NOW = new Date('2026-09-13T10:00:00Z');
let dir: string;
let store: SqliteStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-E-cache-'));
  store = new SqliteStore({ filePath: join(dir, 'db.sqlite') });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function hourlyCall(pricingTier: 'batch' | 'standard'): ApiCall {
  return {
    occurredAt: NOW,
    model: 'claude-haiku-4-5',
    surface: 'review-E',
    ...readUsage({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 1000,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1000 },
    }),
    durationMs: 1,
    attempts: 1,
    requestId: 'hourly-batch:one',
    pricingTier,
  };
}
it('prices an explicitly reported hourly cache write correctly in memory', () => {
  expect(estimateApiCost(hourlyCall('standard'))).toBeCloseTo(0.002, 10);
  expect(estimateApiCost(hourlyCall('batch'))).toBeCloseTo(0.001, 10);
});
it('retains the hour class through persistence and restart for costs reporting', () => {
  const call = hourlyCall('standard');
  appendApiCall(store.db, call);
  store.close();
  store = new SqliteStore({ filePath: join(dir, 'db.sqlite') });
  const row = summarizeApiCalls(store.db, NOW, new Date(NOW.getTime() + 1000)).days[0]!;
  console.log(JSON.stringify({ case: 'cache-store', row, cost: estimateApiCost(row) }));
  expect(estimateApiCost(row)).toBeCloseTo(estimateApiCost(call)!, 10);
});
it('retains the hour class in the durable batch settlement total', () => {
  const call = hourlyCall('batch');
  appendApiCall(store.db, call);
  console.log(
    JSON.stringify({
      case: 'cache-batch',
      expected: estimateApiCost(call),
      actual: chargedApiUsd(store.db, 'hourly-batch'),
    }),
  );
  expect(chargedApiUsd(store.db, 'hourly-batch')).toBeCloseTo(estimateApiCost(call)!, 10);
});
it('carries the marked frame write class into the batch reservation', async () => {
  const request = batchMessagesBody(
    {
      model: 'claude-haiku-4-5',
      surface: 'review-E',
      maxTokens: 64,
      think: false,
      messages: [
        { role: 'system', content: 'Return a structured answer.' },
        { role: 'user', content: 'A question.' },
      ],
      schema: { type: 'object' },
    },
    { frameOverride: { text: 'a meaningful frame sentence. '.repeat(1000) } },
  );
  expect(JSON.stringify(request)).toContain('"ttl":"1h"');
  enqueueBatchWork(store.db, {
    workKey: 'hourly-one',
    substrateId: 'current',
    surface: 'review-E',
    request,
    revalidation: {},
    now: NOW,
  });
  const guard = new GenerationSpendGuard({ db: store.db, ceilingUsd: 5 });
  let held: SpendHoldRequest | undefined;
  const deps: BatchAdapterDeps = {
    db: store.db,
    substrateId: 'current',
    handlers: [],
    now: () => NOW,
    spending: {
      hold: (input) => {
        held = input;
        return guard.hold(input);
      },
      today: (now) => guard.today(now),
    },
    client: {
      apiKey: 'injected',
      fetchImpl: async () =>
        new Response(JSON.stringify({ id: 'hourly-batch', processing_status: 'in_progress' })),
    },
    logger: pino({ enabled: false }),
  };
  expect((await submitBatchWork(deps)).submitted).toBe(1);
  console.log(JSON.stringify({ case: 'cache-hold', held }));
  expect(held).toMatchObject({ cacheWrite: true, cacheWriteTtl: '1h' });
});
