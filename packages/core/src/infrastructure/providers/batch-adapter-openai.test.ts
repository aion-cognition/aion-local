import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { boundApiCost, estimateApiCost } from './api-pricing.js';
import {
  consumeBatchWork,
  MAX_BATCH_ATTEMPTS,
  submitBatchWork,
  type BatchAdapterDeps,
  type BatchWorkHandler,
} from './batch-adapter.js';
import { responsesRequestBody } from './openai-provider.js';
import { GenerationSpendGuard } from './spending.js';
import {
  errorLine,
  OPENAI_BATCH_ID,
  OPENAI_ERROR_FILE,
  OPENAI_INPUT_FILE,
  OPENAI_OUTPUT_FILE,
  openAiBatchApi,
  outputLine,
  responsesAnswer,
  type OpenAiBatchScript,
} from './test-support/openai-batch-api.fixture.js';
import type { GenerationProvider } from './types.js';
import { enqueueBatchWork, readBatchWork, type BatchWorkItem } from '../sqlite/batch-work.js';
import { SqliteStore, type SqliteHandle } from '../sqlite/database.js';

/**
 * The batch lane's lifecycle over the OpenAI transport: which work a submission sends, what it
 * holds against the day, and what consumption does with answers that come back out of order, as
 * error lines, or not at all. The remote is scripted; nothing leaves the process.
 */

const SUBSTRATE = 'substrate-now';
const NOW = new Date('2026-09-28T10:00:00.000Z');
const MODEL = 'gpt-6-luna';

let dir: string;
let store: SqliteStore;
let db: SqliteHandle;
let applied: { readonly workKey: string; readonly answer: unknown }[];

function handler(): BatchWorkHandler {
  return {
    surface: 'judge',
    isCurrent: () => true,
    apply: (item: BatchWorkItem, answer: unknown) => {
      applied.push({ workKey: item.workKey, answer });
      return Promise.resolve();
    },
  };
}

function requestOn(model: string): Record<string, unknown> {
  return responsesRequestBody({
    surface: 'judge',
    model,
    messages: [{ role: 'user', content: 'judge this pair' }],
    schema: { type: 'object' },
    maxTokens: 300,
    temperature: 0,
    think: false,
  });
}

function owe(
  workKey: string,
  provider: GenerationProvider = 'openai',
  request: unknown = requestOn(MODEL),
): void {
  enqueueBatchWork(db, {
    workKey,
    substrateId: SUBSTRATE,
    surface: 'judge',
    revalidation: { pair: workKey },
    request,
    provider,
    now: NOW,
  });
}

function deps(impl: typeof fetch): BatchAdapterDeps {
  return {
    db,
    substrateId: SUBSTRATE,
    provider: 'openai',
    client: { apiKey: 'sk-test-openai', fetchImpl: impl },
    handlers: [handler()],
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    } as unknown as BatchAdapterDeps['logger'],
    spending: new GenerationSpendGuard({ db, ceilingUsd: 5 }),
    now: () => NOW,
  };
}

type SpendRow = { reserved_usd: number; settled_usd: number | null; state: string; route: string };

function spendRows(): SpendRow[] {
  return db
    .prepare('SELECT reserved_usd, settled_usd, state, route FROM generation_spend')
    .all() as SpendRow[];
}

const USAGE = {
  input_tokens: 1000,
  output_tokens: 100,
  input_tokens_details: { cached_tokens: 400 },
  output_tokens_details: { reasoning_tokens: 0 },
};

/** What one answer carrying `USAGE` costs at the batch rate, as the books price it. */
const ANSWER_USD =
  estimateApiCost({
    model: MODEL,
    pricingTier: 'batch',
    inputTokens: 600,
    outputTokens: 100,
    cacheCreationTokens: 0,
    cacheReadTokens: 400,
  }) ?? Number.NaN;

async function submitThenConsume(
  script: OpenAiBatchScript,
): Promise<Awaited<ReturnType<typeof consumeBatchWork>>> {
  const { impl } = openAiBatchApi(script);
  await submitBatchWork(deps(impl));
  return consumeBatchWork(deps(impl));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-batch-openai-'));
  store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  ({ db } = store);
  applied = [];
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('submitting to OpenAI', () => {
  it('sends only the work encoded for OpenAI and records who holds it', async () => {
    owe('pair-a');
    owe('pair-b');
    owe('pair-anthropic', 'anthropic', { model: 'claude-haiku-4-5', max_tokens: 64 });
    const { calls, impl } = openAiBatchApi();

    const report = await submitBatchWork(deps(impl));

    expect(report).toEqual({ submitted: 2, batchId: OPENAI_BATCH_ID });
    const sent = (calls[0]?.upload?.text ?? '')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => (JSON.parse(line) as { custom_id: string }).custom_id);
    expect(sent).toEqual(['pair-a', 'pair-b']);
    expect(readBatchWork(db, 'pair-a')).toMatchObject({
      state: 'submitted',
      batchId: OPENAI_BATCH_ID,
      provider: 'openai',
    });
    // Encoded for the other vendor, so this vendor never receives it.
    expect(readBatchWork(db, 'pair-anthropic')).toMatchObject({
      state: 'pending',
      provider: 'anthropic',
    });
  });

  it('holds the submission at the batch rate on the OpenAI card, with no cache write to cover', async () => {
    owe('pair-a');
    const { impl } = openAiBatchApi();

    await submitBatchWork(deps(impl));

    const bytes = Buffer.byteLength(JSON.stringify(requestOn(MODEL)), 'utf8');
    const expected = boundApiCost({
      model: MODEL,
      inputTokens: bytes,
      outputTokens: 300,
      pricingTier: 'batch',
      cacheWrite: false,
      provider: 'openai',
    }).maxUsd;
    expect(spendRows()).toEqual([
      { reserved_usd: expected, settled_usd: null, state: 'held', route: 'batch' },
    ]);
  });

  it("bounds a model the price table does not carry at OpenAI's own card", async () => {
    const unpriced = requestOn('gpt-unpriced');
    owe('pair-a', 'openai', unpriced);
    const { impl } = openAiBatchApi();

    await submitBatchWork(deps(impl));

    const bound = {
      model: 'gpt-unpriced',
      inputTokens: Buffer.byteLength(JSON.stringify(unpriced), 'utf8'),
      outputTokens: 300,
      pricingTier: 'batch' as const,
      cacheWrite: false,
    };
    const [held] = spendRows();
    expect(held?.reserved_usd).toBeCloseTo(
      boundApiCost({ ...bound, provider: 'openai' }).maxUsd,
      12,
    );
    expect(held?.reserved_usd).toBeGreaterThan(
      boundApiCost({ ...bound, provider: 'anthropic' }).maxUsd,
    );
  });
});

describe('consuming what OpenAI returned', () => {
  it('applies answers by custom_id in whatever order they return, and bills each at the batch tier', async () => {
    owe('pair-a');
    owe('pair-b');

    const report = await submitThenConsume({
      output: [
        outputLine('pair-b', responsesAnswer('{"verdict":"b"}', USAGE)),
        outputLine('pair-a', responsesAnswer('{"verdict":"a"}', USAGE)),
      ],
    });

    expect(report).toMatchObject({ applied: 2, returned: 0, unrecognized: 0 });
    expect(applied).toEqual([
      { workKey: 'pair-b', answer: { verdict: 'b' } },
      { workKey: 'pair-a', answer: { verdict: 'a' } },
    ]);
    expect(readBatchWork(db, 'pair-a')?.state).toBe('applied');
    const bills = db
      .prepare(
        `SELECT request_id, model, pricing_tier, input_tokens, cache_read_tokens, output_tokens
         FROM api_calls ORDER BY request_id`,
      )
      .all();
    // Ordinary input is what the prompt carried less its cached share, so nothing bills twice.
    expect(bills).toEqual([
      {
        request_id: `${OPENAI_BATCH_ID}:pair-a`,
        model: MODEL,
        pricing_tier: 'batch',
        input_tokens: 600,
        cache_read_tokens: 400,
        output_tokens: 100,
      },
      {
        request_id: `${OPENAI_BATCH_ID}:pair-b`,
        model: MODEL,
        pricing_tier: 'batch',
        input_tokens: 600,
        cache_read_tokens: 400,
        output_tokens: 100,
      },
    ]);
    const [spend] = spendRows();
    expect(spend?.state).toBe('settled');
    expect(spend?.settled_usd).toBeCloseTo(2 * ANSWER_USD, 12);
  });

  it('owes again what came back as an error line, and what the ended job never mentioned', async () => {
    owe('pair-a');
    owe('pair-b');
    owe('pair-c');

    const report = await submitThenConsume({
      output: [outputLine('pair-a', responsesAnswer('{"verdict":"a"}', USAGE))],
      errors: [errorLine('pair-b', 'batch_expired')],
    });

    expect(report).toMatchObject({ applied: 1, returned: 2 });
    expect(readBatchWork(db, 'pair-b')).toMatchObject({ state: 'pending', batchId: undefined });
    expect(readBatchWork(db, 'pair-b')?.lastError).toContain('batch_expired');
    // Neither file changes once the job has ended, so an unmentioned row will never be answered.
    expect(readBatchWork(db, 'pair-c')).toMatchObject({ state: 'pending', batchId: undefined });
    expect(readBatchWork(db, 'pair-c')?.lastError).toContain('returned no answer');
    // Only the answered request is priced; nothing is left at the remote to hold for.
    expect(spendRows()[0]?.settled_usd).toBeCloseTo(ANSWER_USD, 12);
  });

  it('fails a refused answer rather than asking it again', async () => {
    owe('pair-a');

    const report = await submitThenConsume({
      output: [
        outputLine('pair-a', {
          ...responsesAnswer('{}', USAGE),
          output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }],
        }),
      ],
    });

    expect(report).toMatchObject({ failed: 1, returned: 0 });
    expect(readBatchWork(db, 'pair-a')?.state).toBe('failed');
    expect(db.prepare('SELECT count(*) AS n FROM api_calls').get()).toEqual({ n: 1 });
  });

  it('fails a row once it has used its attempts, instead of paying for it forever', async () => {
    owe('pair-a');
    const script = { output: [outputLine('pair-a', responsesAnswer('not json', USAGE))] };

    for (let attempt = 1; attempt <= MAX_BATCH_ATTEMPTS; attempt += 1) {
      await submitThenConsume(script);
    }

    expect(readBatchWork(db, 'pair-a')).toMatchObject({
      state: 'failed',
      attempts: MAX_BATCH_ATTEMPTS,
    });
    expect(readBatchWork(db, 'pair-a')?.lastError).toContain(
      `no usable answer after ${String(MAX_BATCH_ATTEMPTS)} attempts`,
    );
  });

  it('releases the hold when the upload is refused, since no job exists', async () => {
    owe('pair-a');
    const { impl } = openAiBatchApi({ uploadStatus: 403 });

    const report = await submitBatchWork(deps(impl));

    expect(report).toEqual({ submitted: 0, batchId: undefined });
    expect(readBatchWork(db, 'pair-a')?.state).toBe('pending');
    expect(spendRows()[0]?.state).toBe('released');
  });

  it('releases the hold when the job is refused, and deletes the upload', async () => {
    owe('pair-a');
    const { calls, impl } = openAiBatchApi({ createStatus: 400 });

    await submitBatchWork(deps(impl));

    expect(spendRows()[0]?.state).toBe('released');
    expect(calls.map((call) => call.method)).toEqual(['POST', 'POST', 'DELETE']);
  });

  it('owes again an answer that carries no usable JSON, and still bills it', async () => {
    owe('pair-a');

    const report = await submitThenConsume({
      output: [outputLine('pair-a', responsesAnswer('not json at all', USAGE))],
    });

    expect(report).toMatchObject({ applied: 0, returned: 1 });
    expect(readBatchWork(db, 'pair-a')?.state).toBe('pending');
    expect(db.prepare('SELECT count(*) AS n FROM api_calls').get()).toEqual({ n: 1 });
  });

  it('owes again every row of a job the remote refused whole, and holds nothing for it', async () => {
    owe('pair-a');
    owe('pair-b');

    const report = await submitThenConsume({
      statuses: ['failed'],
      batchErrors: { data: [{ code: 'invalid_request', message: 'bad line', line: 1 }] },
    });

    expect(report).toMatchObject({ returned: 2, applied: 0 });
    expect(readBatchWork(db, 'pair-a')).toMatchObject({ state: 'pending', batchId: undefined });
    expect(readBatchWork(db, 'pair-a')?.lastError).toContain('invalid_request');
    expect(spendRows()[0]).toMatchObject({ state: 'settled', settled_usd: 0 });
  });

  it('waits on a job still running and settles nothing', async () => {
    owe('pair-a');

    const report = await submitThenConsume({ statuses: ['in_progress'] });

    expect(report).toMatchObject({ waiting: 1, applied: 0 });
    expect(readBatchWork(db, 'pair-a')?.state).toBe('submitted');
    expect(spendRows()[0]?.state).toBe('held');
  });

  it("deletes the job's files at OpenAI once every row it carried has settled", async () => {
    owe('pair-a');
    owe('pair-b');
    const { calls, impl } = openAiBatchApi({
      output: [outputLine('pair-a', responsesAnswer('{"verdict":"a"}', USAGE))],
      errors: [errorLine('pair-b', 'batch_expired')],
    });

    await submitBatchWork(deps(impl));
    await consumeBatchWork(deps(impl));

    expect(
      calls.filter((call) => call.method === 'DELETE').map((call) => call.url.split('/').pop()),
    ).toEqual([OPENAI_INPUT_FILE, OPENAI_OUTPUT_FILE, OPENAI_ERROR_FILE]);
  });

  it('tries a failed file deletion again on the next pass until it succeeds', async () => {
    owe('pair-a');
    const { calls, impl } = openAiBatchApi({
      output: [outputLine('pair-a', responsesAnswer('{"verdict":"a"}', USAGE))],
      deleteFailures: 1,
    });

    await submitBatchWork(deps(impl));
    await consumeBatchWork(deps(impl));
    const firstPass = calls.filter((call) => call.method === 'DELETE').length;
    await consumeBatchWork(deps(impl));
    await consumeBatchWork(deps(impl));

    const deletes = calls.filter((call) => call.method === 'DELETE').map((call) => call.url);
    expect(firstPass).toBe(1);
    // The second pass deletes every file; the third finds nothing left to retry.
    expect(deletes.slice(1).map((url) => url.split('/').pop())).toEqual([
      OPENAI_INPUT_FILE,
      OPENAI_OUTPUT_FILE,
    ]);
  });

  it('never reads a job another provider holds', async () => {
    owe('pair-anthropic', 'anthropic', { model: 'claude-haiku-4-5', max_tokens: 64 });
    db.prepare(`UPDATE batch_work SET state = 'submitted', batch_id = 'msgbatch_held'`).run();
    const { calls, impl } = openAiBatchApi();

    const report = await consumeBatchWork(deps(impl));

    expect(calls).toEqual([]);
    expect(report).toMatchObject({ waiting: 0, applied: 0 });
    expect(readBatchWork(db, 'pair-anthropic')?.state).toBe('submitted');
  });
});
