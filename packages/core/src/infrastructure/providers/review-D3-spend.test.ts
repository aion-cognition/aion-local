import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, expect, it } from 'vitest';

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

it.each([false, true])(
  'does not turn a failed usage insert into a free completed response (fail=%s)',
  async (fail) => {
    owe('one');
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
          id: 'batch-bill',
          processing_status: address.endsWith('/batches') ? 'in_progress' : 'ended',
          results_url: 'https://api.anthropic.com/v1/messages/batches/batch-bill/results',
        }),
      );
    };
    const input = deps(api);
    await submitBatchWork(input);
    if (fail) {
      store.db
        .prepare(
          "CREATE TEMP TRIGGER reject_bill BEFORE INSERT ON api_calls BEGIN SELECT RAISE(FAIL, 'injected usage persistence failure'); END",
        )
        .run();
    }
    let result: unknown;
    try {
      result = await consumeBatchWork(input);
    } catch (error) {
      result = String(error);
    }
    const state = readBatchWork(store.db, 'one')?.state;
    console.log(JSON.stringify({ fail, state, result, totals: spending.today(NOW) }));
    expect(spending.today(NOW).committedUsd).toBeGreaterThan(0);
    if (!fail) {
      expect(state).toBe('applied');
      expect(spending.today(NOW).committedUsd).toBeCloseTo(0.0001, 8);
    }
  },
);
