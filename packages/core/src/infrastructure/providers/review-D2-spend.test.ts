import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { requestAnthropicJson } from './anthropic-provider.js';
import { submitBatchWork, consumeBatchWork, type BatchAdapterDeps } from './batch-adapter.js';
import { GenerationSpendGuard } from './spending.js';
import { enqueueBatchWork, readBatchWork } from '../sqlite/batch-work.js';
import { SqliteStore } from '../sqlite/database.js';

const NOW = new Date('2026-09-13T10:00:00Z');
const REQUEST = {
  model: 'claude-haiku-4-5',
  surface: 'review',
  maxTokens: 1000,
  messages: [{ role: 'user' as const, content: 'a pending question' }],
  schema: { type: 'object' },
};
let dir: string;
let store: SqliteStore;
let spending: GenerationSpendGuard;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-D2-spend-'));
  store = new SqliteStore({ filePath: join(dir, 'db.sqlite') });
  spending = new GenerationSpendGuard({ db: store.db, ceilingUsd: 5 });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function owe(key: string) {
  enqueueBatchWork(store.db, {
    workKey: key,
    substrateId: 'current',
    surface: 'review',
    now: NOW,
    revalidation: {},
    request: { model: REQUEST.model, max_tokens: 1000, messages: REQUEST.messages },
  });
}
function deps(fetchImpl: typeof fetch): BatchAdapterDeps {
  return {
    db: store.db,
    substrateId: 'current',
    spending,
    now: () => NOW,
    client: { apiKey: 'injected', fetchImpl },
    handlers: [{ surface: 'review', isCurrent: () => true, apply: () => Promise.resolve() }],
    logger: pino({ enabled: false }),
  };
}

it('keeps the monetary hold after a dispatched Messages request loses its response', async () => {
  let sent = 0;
  await expect(
    requestAnthropicJson(
      {
        apiKey: 'injected',
        spending,
        now: () => NOW.getTime(),
        fetchImpl: async () => {
          sent += 1;
          throw new TypeError('connection lost after remote acceptance');
        },
      },
      REQUEST,
    ),
  ).rejects.toThrow();
  expect(sent).toBe(1);
  console.log(JSON.stringify({ scenario: 'lost-message-response', totals: spending.today(NOW) }));
  expect(spending.today(NOW).committedUsd).toBeGreaterThan(0);
});

it('does not make an HTTP 200 answer free when the caller aborts before consuming it', async () => {
  const controller = new AbortController();
  await expect(
    requestAnthropicJson(
      {
        apiKey: 'injected',
        spending,
        now: () => NOW.getTime(),
        fetchImpl: async () => {
          controller.abort();
          return new Response(
            JSON.stringify({
              content: [{ type: 'text', text: '{}' }],
              usage: { input_tokens: 100, output_tokens: 20 },
            }),
          );
        },
      },
      { ...REQUEST, signal: controller.signal },
    ),
  ).rejects.toThrow();
  console.log(JSON.stringify({ scenario: 'paid-answer-aborted', totals: spending.today(NOW) }));
  expect(spending.today(NOW).committedUsd).toBeGreaterThan(0);
});

it('keeps the monetary hold when batch acceptance is uncertain', async () => {
  owe('one');
  let sent = 0;
  await submitBatchWork(
    deps(async () => {
      sent += 1;
      throw new TypeError('accepted remotely, response lost');
    }),
  );
  expect(sent).toBe(1);
  expect(readBatchWork(store.db, 'one')?.state).toBe('pending');
  console.log(JSON.stringify({ scenario: 'lost-batch-response', totals: spending.today(NOW) }));
  expect(spending.today(NOW).committedUsd).toBeGreaterThan(0);
});

it('keeps coverage for the unaccounted portion of a partially read results file', async () => {
  owe('one');
  owe('two');
  const api: typeof fetch = async (url) => {
    const address = url instanceof Request ? url.url : url.toString();
    if (address.endsWith('/results')) {
      return new Response(
        JSON.stringify({
          custom_id: 'one',
          result: {
            type: 'succeeded',
            message: {
              model: REQUEST.model,
              content: [{ type: 'text', text: '{}' }],
              usage: { input_tokens: 100, output_tokens: 20 },
            },
          },
        }),
      );
    }
    return new Response(
      JSON.stringify({
        id: 'batch-one',
        processing_status: address.endsWith('/batches') ? 'in_progress' : 'ended',
        results_url: 'https://api.anthropic.com/v1/messages/batches/batch-one/results',
      }),
    );
  };
  await submitBatchWork(deps(api));
  await consumeBatchWork(deps(api));
  expect(readBatchWork(store.db, 'one')?.state).toBe('applied');
  expect(readBatchWork(store.db, 'two')?.state).toBe('submitted');
  console.log(JSON.stringify({ scenario: 'partial-result', totals: spending.today(NOW) }));
  // The first answer costs $0.0001 at the batch rate. The second has not been accounted for.
  expect(spending.today(NOW).committedUsd).toBeGreaterThan(0.0001);
});

it('still dispatches nothing when a known ceiling cannot cover the request', async () => {
  spending = new GenerationSpendGuard({ db: store.db, ceilingUsd: 0 });
  let sent = 0;
  await expect(
    requestAnthropicJson(
      {
        apiKey: 'injected',
        spending,
        now: () => NOW.getTime(),
        fetchImpl: async () => {
          sent += 1;
          throw new Error('must not dispatch');
        },
      },
      REQUEST,
    ),
  ).rejects.toThrow("today's ceiling");
  expect(sent).toBe(0);
  expect(spending.today(NOW).committedUsd).toBe(0);
});

it('does not bypass an explicit zero-dollar ceiling for a model absent from the price table', () => {
  const guard = new GenerationSpendGuard({ db: store.db, ceilingUsd: 0 });
  const result = guard.hold({
    surface: 'review',
    model: 'claude-sonnet-4-5',
    route: 'messages',
    inputTokens: 1000,
    outputTokens: 1000,
    now: NOW,
  });
  console.log(JSON.stringify({ scenario: 'unpriced-at-zero-ceiling', allowed: 'hold' in result }));
  expect('refused' in result).toBe(true);
});
