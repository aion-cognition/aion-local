import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { legalCustomId } from './anthropic-batches.js';
import {
  consumeBatchWork,
  submitBatchWork,
  type BatchAdapterDeps,
  type BatchWorkHandler,
} from './batch-adapter.js';
import { summarizeApiCalls } from '../sqlite/api-usage.js';
import { enqueueBatchWork, readBatchWork, type BatchWorkItem } from '../sqlite/batch-work.js';
import { SqliteStore, type SqliteHandle } from '../sqlite/database.js';

/**
 * The adapter's mechanics against injected answers: what a submission records, what consumption
 * does with each of the four outcomes, and what it refuses to apply. No batch is sent here. The
 * live round trip is `batch-adapter.int.test.ts`.
 */

const SUBSTRATE = 'substrate-now';
const OTHER_SUBSTRATE = 'substrate-before-the-reset';
const NOW = new Date('2026-09-13T10:00:00.000Z');

type Applied = { readonly workKey: string; readonly answer: unknown };

let dir: string;
let store: SqliteStore;
let db: SqliteHandle;
let applied: Applied[];
let current: boolean;
let applyError: Error | undefined;

function handler(): BatchWorkHandler {
  return {
    surface: 'judge',
    isCurrent: () => current,
    apply: (item: BatchWorkItem, answer: unknown) => {
      if (applyError !== undefined) {
        return Promise.reject(applyError);
      }
      applied.push({ workKey: item.workKey, answer });
      return Promise.resolve();
    },
  };
}

/**
 * A fetch that answers the three batch endpoints from a script, and records what was asked.
 *
 * It refuses a submission carrying an id outside the documented `custom_id` contract, the way the
 * remote does. A mock that accepts any string reads a producer whose ids the API would never take
 * as a working producer, and every case downstream of it inherits that reading.
 */
function batchApi(script: {
  readonly createId?: string;
  readonly createStatus?: number;
  readonly processingStatus?: string;
  readonly results?: readonly Record<string, unknown>[];
}): { calls: { url: string; body: unknown }[]; impl: typeof fetch } {
  const calls: { url: string; body: unknown }[] = [];
  const impl = vi.fn((url: string | URL, init?: RequestInit) => {
    const target = String(url);
    calls.push({
      url: target,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    });
    if (target.endsWith('/batches')) {
      const submitted = (calls[calls.length - 1]?.body as { requests?: { custom_id: string }[] })
        .requests;
      const rejected = (submitted ?? []).find((request) => !legalCustomId(request.custom_id));
      if (rejected !== undefined) {
        return Promise.resolve(
          new Response(`custom_id ${rejected.custom_id} is not accepted`, { status: 400 }),
        );
      }
      if (script.createStatus !== undefined) {
        return Promise.resolve(new Response('nope', { status: script.createStatus }));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: script.createId ?? 'msgbatch_1',
            processing_status: 'in_progress',
          }),
        ),
      );
    }
    if (target.endsWith('/results')) {
      return Promise.resolve(
        new Response((script.results ?? []).map((line) => JSON.stringify(line)).join('\n')),
      );
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: script.createId ?? 'msgbatch_1',
          processing_status: script.processingStatus ?? 'ended',
          results_url: `https://api.anthropic.com/v1/messages/batches/${script.createId ?? 'msgbatch_1'}/results`,
        }),
      ),
    );
  });
  return { calls, impl: impl as unknown as typeof fetch };
}

function deps(impl: typeof fetch): BatchAdapterDeps {
  return {
    db,
    substrateId: SUBSTRATE,
    client: { apiKey: 'sk-ant-test', fetchImpl: impl },
    handlers: [handler()],
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    } as unknown as BatchAdapterDeps['logger'],
    now: () => NOW,
  };
}

function owe(workKey: string, substrateId: string = SUBSTRATE, surface = 'judge'): void {
  enqueueBatchWork(db, {
    workKey,
    substrateId,
    surface,
    revalidation: { pair: workKey },
    request: { model: 'claude-haiku-4-5', max_tokens: 64, messages: [] },
    now: NOW,
  });
}

function succeeded(workKey: string, json: string): Record<string, unknown> {
  return {
    custom_id: workKey,
    result: { type: 'succeeded', message: { content: [{ type: 'text', text: json }] } },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-batch-adapter-'));
  store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  ({ db } = store);
  applied = [];
  current = true;
  applyError = undefined;
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('submitting owed work', () => {
  it('sends one batch keyed by work key and records the remote identity', async () => {
    owe('pair-a');
    owe('pair-b');
    const { calls, impl } = batchApi({ createId: 'msgbatch_abc' });

    const report = await submitBatchWork(deps(impl));

    expect(report).toEqual({ submitted: 2, batchId: 'msgbatch_abc' });
    expect(
      (calls[0]?.body as { requests: { custom_id: string }[] }).requests.map((r) => r.custom_id),
    ).toEqual(['pair-a', 'pair-b']);
    // Submission is not completion: the rows say who is holding the work, not that it is done.
    expect(readBatchWork(db, 'pair-a')).toMatchObject({
      state: 'submitted',
      batchId: 'msgbatch_abc',
      attempts: 1,
    });
  });

  it('leaves the work owed when the submission fails', async () => {
    owe('pair-a');
    const { impl } = batchApi({ createStatus: 500 });

    const report = await submitBatchWork(deps(impl));

    expect(report).toEqual({ submitted: 0, batchId: undefined });
    expect(readBatchWork(db, 'pair-a')).toMatchObject({ state: 'pending', attempts: 0 });
  });

  it('sends no batch at all over a work key the remote would refuse', async () => {
    owe('judge:7f3a:1');
    owe('pair-b');
    const { calls, impl } = batchApi({ createId: 'msgbatch_abc' });

    const report = await submitBatchWork(deps(impl));

    // The legal row still goes. The other one is terminal rather than owed again, because the
    // next pass would build the same id from the same inputs and lose the batch a second time.
    expect(report).toEqual({ submitted: 1, batchId: 'msgbatch_abc' });
    expect(
      (calls[0]?.body as { requests: { custom_id: string }[] }).requests.map((r) => r.custom_id),
    ).toEqual(['pair-b']);
    expect(readBatchWork(db, 'judge:7f3a:1')).toMatchObject({
      state: 'failed',
      lastError: 'the work key is not a legal batch custom_id',
    });
  });

  it('records the producer identity the work key was derived from', () => {
    enqueueBatchWork(db, {
      workKey: 'df-0f1e2d',
      durableKey: 'description_freshness:entity-9:1:abc',
      substrateId: SUBSTRATE,
      surface: 'judge',
      revalidation: {},
      request: {},
      now: NOW,
    });

    // The remote id is a digest, so the row is the only place the question it names is written.
    expect(readBatchWork(db, 'df-0f1e2d')?.durableKey).toBe('description_freshness:entity-9:1:abc');
    expect(readBatchWork(db, 'pair-a')).toBeUndefined();
  });

  it('sends nothing for another substrate work', async () => {
    owe('pair-a', OTHER_SUBSTRATE);
    const { calls, impl } = batchApi({});

    expect(await submitBatchWork(deps(impl))).toEqual({ submitted: 0, batchId: undefined });
    expect(calls).toEqual([]);
  });

  it('enqueues one row for a work key however often it is owed', () => {
    expect(
      enqueueBatchWork(db, {
        workKey: 'pair-a',
        substrateId: SUBSTRATE,
        surface: 'judge',
        revalidation: {},
        request: {},
        now: NOW,
      }),
    ).toBe(true);
    expect(
      enqueueBatchWork(db, {
        workKey: 'pair-a',
        substrateId: SUBSTRATE,
        surface: 'judge',
        revalidation: {},
        request: {},
        now: NOW,
      }),
    ).toBe(false);
  });
});

describe('consuming what came back', () => {
  async function submitThenConsume(
    script: Parameters<typeof batchApi>[0],
  ): Promise<ReturnType<typeof consumeBatchWork>> {
    const { impl } = batchApi(script);
    await submitBatchWork(deps(impl));
    return consumeBatchWork(deps(impl));
  }

  it('applies an answer by identity rather than by position', async () => {
    owe('pair-a');
    owe('pair-b');

    const report = await submitThenConsume({
      results: [succeeded('pair-b', '{"verdict":"b"}'), succeeded('pair-a', '{"verdict":"a"}')],
    });

    expect(report).toMatchObject({ applied: 2, discarded: 0, returned: 0 });
    expect(applied).toEqual([
      { workKey: 'pair-b', answer: { verdict: 'b' } },
      { workKey: 'pair-a', answer: { verdict: 'a' } },
    ]);
    expect(readBatchWork(db, 'pair-a')?.state).toBe('applied');
  });

  it('discards an answer the substrate has moved past instead of applying it', async () => {
    owe('pair-a');
    current = false;

    const report = await submitThenConsume({ results: [succeeded('pair-a', '{"verdict":"a"}')] });

    expect(report).toMatchObject({ applied: 0, discarded: 1 });
    expect(applied).toEqual([]);
    expect(readBatchWork(db, 'pair-a')).toMatchObject({
      state: 'discarded',
      lastError: 'the substrate moved',
    });
  });

  it('owes the work again when the remote expired it', async () => {
    owe('pair-a');

    const report = await submitThenConsume({
      results: [{ custom_id: 'pair-a', result: { type: 'expired', error: { type: 'expired' } } }],
    });

    expect(report).toMatchObject({ returned: 1 });
    expect(readBatchWork(db, 'pair-a')).toMatchObject({ state: 'pending', batchId: undefined });
  });

  it('owes the work again when the remote cancelled or errored it', async () => {
    for (const type of ['canceled', 'errored']) {
      owe(`pair-${type}`);
    }

    const report = await submitThenConsume({
      results: [
        { custom_id: 'pair-canceled', result: { type: 'canceled' } },
        { custom_id: 'pair-errored', result: { type: 'errored', error: { type: 'overloaded' } } },
      ],
    });

    expect(report).toMatchObject({ returned: 2, applied: 0 });
    expect(readBatchWork(db, 'pair-errored')).toMatchObject({ state: 'pending' });
    expect(readBatchWork(db, 'pair-errored')?.lastError).toContain('overloaded');
  });

  it('owes the work again when applying it throws, rather than losing the answer', async () => {
    owe('pair-a');
    applyError = new Error('the graph refused the write');

    const report = await submitThenConsume({ results: [succeeded('pair-a', '{"verdict":"a"}')] });

    expect(report).toMatchObject({ returned: 1, applied: 0 });
    expect(readBatchWork(db, 'pair-a')).toMatchObject({
      state: 'pending',
      lastError: 'the graph refused the write',
    });
  });

  it('recognizes no answer whose work key this substrate does not hold', async () => {
    owe('pair-a');

    const report = await submitThenConsume({
      results: [succeeded('pair-a', '{"verdict":"a"}'), succeeded('pair-from-before', '{"v":1}')],
    });

    expect(report).toMatchObject({ applied: 1, unrecognized: 1 });
    expect(readBatchWork(db, 'pair-from-before')).toBeUndefined();
  });

  it('waits on a batch the remote is still working, and settles nothing', async () => {
    owe('pair-a');

    const report = await submitThenConsume({ processingStatus: 'in_progress', results: [] });

    expect(report).toMatchObject({ waiting: 1, applied: 0 });
    expect(readBatchWork(db, 'pair-a')?.state).toBe('submitted');
  });

  it('fails work whose surface has no handler rather than guessing at it', async () => {
    owe('pair-a', SUBSTRATE, 'a-surface-nothing-registered');

    const report = await submitThenConsume({ results: [succeeded('pair-a', '{"verdict":"a"}')] });

    expect(report).toMatchObject({ failed: 1 });
    expect(readBatchWork(db, 'pair-a')?.lastError).toContain('no handler');
  });

  it('leaves a row the results file never mentioned outstanding', async () => {
    owe('pair-a');
    owe('pair-b');

    const report = await submitThenConsume({ results: [succeeded('pair-a', '{"verdict":"a"}')] });

    expect(report).toMatchObject({ applied: 1 });
    expect(readBatchWork(db, 'pair-b')?.state).toBe('submitted');
  });

  it('bills an answer nobody could place, because the substrate paid for it either way', async () => {
    owe('pair-a');

    await submitThenConsume({
      results: [
        succeeded('pair-a', '{"verdict":"a"}'),
        succeeded('pair-from-before-the-reset', '{"v":1}'),
      ],
    });

    const bill = summarizeApiCalls(
      db,
      new Date('2026-09-13T00:00:00.000Z'),
      new Date('2026-09-14T00:00:00.000Z'),
    );
    // Two paid responses, one of them for work this store no longer holds. The one it cannot
    // place is charged under `unlabeled` rather than left off the bill.
    expect(bill.surfaces.map((row) => [row.key, row.calls, row.pricingTier])).toEqual([
      ['judge', 1, 'batch'],
      ['unlabeled', 1, 'batch'],
    ]);
  });

  it('records an answer with no readable usage as unknown rather than as free', async () => {
    owe('pair-a');

    await submitThenConsume({
      results: [
        {
          custom_id: 'pair-a',
          result: {
            type: 'succeeded',
            message: { content: [{ type: 'text', text: '{"verdict":"a"}' }], usage: { broken: 1 } },
          },
        },
      ],
    });

    const bill = summarizeApiCalls(
      db,
      new Date('2026-09-13T00:00:00.000Z'),
      new Date('2026-09-14T00:00:00.000Z'),
    );
    expect(bill.surfaces[0]).toMatchObject({ calls: 1, usageErrors: 1, inputTokens: 0 });
  });
});

describe('a reset in the middle of an outstanding batch', () => {
  it('applies nothing addressed to the substrate that is gone', async () => {
    owe('pair-a', OTHER_SUBSTRATE);
    // The old substrate's row is submitted the way its own service would have left it.
    db.prepare(
      `UPDATE batch_work SET state = 'submitted', batch_id = 'msgbatch_old' WHERE work_key = ?`,
    ).run('pair-a');
    const { calls, impl } = batchApi({ results: [succeeded('pair-a', '{"verdict":"a"}')] });

    const report = await consumeBatchWork(deps(impl));

    // The new substrate never asks about a batch it did not submit.
    expect(calls).toEqual([]);
    expect(report).toMatchObject({ applied: 0, unrecognized: 0, waiting: 0 });
    expect(applied).toEqual([]);
    expect(readBatchWork(db, 'pair-a')?.state).toBe('submitted');
  });
});
