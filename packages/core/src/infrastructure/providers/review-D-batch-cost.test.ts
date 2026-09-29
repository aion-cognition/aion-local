import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { expect, it } from 'vitest';

import { consumeBatchWork, submitBatchWork, type BatchAdapterDeps } from './batch-adapter.js';
import { summarizeApiCalls } from '../sqlite/api-usage.js';
import { enqueueBatchWork, readBatchWork } from '../sqlite/batch-work.js';
import { SqliteStore } from '../sqlite/database.js';

it.each([true, false])('accounts for the paid response even when current=%s', async (current) => {
  const dir = mkdtempSync(join(tmpdir(), 'aion-D-batch-bill-'));
  const store = new SqliteStore({ filePath: join(dir, 'store.sqlite') });
  const now = new Date('2026-09-13T10:00:00Z');
  let applications = 0;
  const deps: BatchAdapterDeps = {
    db: store.db,
    substrateId: 'this-substrate',
    client: {
      apiKey: 'injected-test-key',
      fetchImpl: async (url) => {
        const address = url instanceof Request ? url.url : url.toString();
        if (address.endsWith('/results')) {
          return new Response(
            JSON.stringify({
              custom_id: 'ready-item',
              result: {
                type: 'succeeded',
                message: {
                  id: 'message-one',
                  model: 'claude-haiku-4-5',
                  content: [{ type: 'text', text: '{"description":"A concise result"}' }],
                  usage: {
                    input_tokens: 100,
                    output_tokens: 20,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                  },
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
      },
    },
    handlers: [
      {
        surface: 'background',
        isCurrent: () => current,
        apply: async () => {
          applications += 1;
        },
      },
    ],
    logger: pino({ enabled: false }),
    now: () => now,
  };
  try {
    enqueueBatchWork(store.db, {
      workKey: 'ready-item',
      substrateId: deps.substrateId,
      surface: 'background',
      revalidation: { revision: 1 },
      now,
      request: {
        model: 'claude-haiku-4-5',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'summarize this' }],
      },
    });
    await submitBatchWork(deps);
    await consumeBatchWork(deps);
    expect(readBatchWork(store.db, 'ready-item')?.state).toBe(current ? 'applied' : 'discarded');
    expect(applications).toBe(current ? 1 : 0);
    const bill = summarizeApiCalls(
      store.db,
      new Date('2026-09-13T00:00:00Z'),
      new Date('2026-09-14T00:00:00Z'),
    );
    console.log(
      JSON.stringify({
        current,
        state: readBatchWork(store.db, 'ready-item')?.state,
        applications,
        bill,
      }),
    );
    expect(bill.surfaces.reduce((total, row) => total + row.inputTokens, 0)).toBe(100);
    expect(bill.surfaces.reduce((total, row) => total + row.outputTokens, 0)).toBe(20);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
