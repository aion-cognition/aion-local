import { describe, expect, it } from 'vitest';

import { OpenAiBatchTransport } from './openai-batches.js';
import { OpenAiRequestError, responsesRequestBody } from './openai-provider.js';
import {
  errorLine,
  OPENAI_BATCH_ID,
  OPENAI_ERROR_FILE,
  OPENAI_INPUT_FILE,
  OPENAI_OUTPUT_FILE,
  openAiBatchApi,
  outputLine,
  responsesAnswer,
} from './test-support/openai-batch-api.fixture.js';

/**
 * The OpenAI Batch transport against a scripted remote: what goes up, how a job's status reads,
 * and what each line of its files becomes. The lane that uses it is `batch-adapter-openai.test.ts`.
 */

const KEY = 'sk-test-openai';

const BODY = responsesRequestBody({
  surface: 'description_freshness',
  model: 'gpt-6-luna',
  messages: [
    { role: 'system', content: 'Rewrite the gloss.' },
    { role: 'user', content: 'Entity: pool' },
  ],
  schema: { type: 'object' },
  maxTokens: 300,
  temperature: 0,
  think: false,
});

describe('sending a job', () => {
  it('uploads the requests as JSONL for the batch purpose, then creates the job over that file', async () => {
    const { calls, impl } = openAiBatchApi();
    const transport = new OpenAiBatchTransport({ apiKey: KEY, fetchImpl: impl });

    const batchId = await transport.create([
      { customId: 'df-a', params: BODY },
      { customId: 'df-b', params: BODY },
    ]);

    expect(batchId).toBe(OPENAI_BATCH_ID);
    const [upload, create] = calls;
    expect(upload).toMatchObject({
      method: 'POST',
      url: 'https://api.openai.com/v1/files',
      authorization: `Bearer ${KEY}`,
      upload: { purpose: 'batch' },
    });
    expect(upload?.upload?.filename.endsWith('.jsonl')).toBe(true);
    const lines = (upload?.upload?.text ?? '')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as unknown);
    // One line per request, each naming the endpoint the job names and carrying the body whole.
    expect(lines).toEqual([
      { custom_id: 'df-a', method: 'POST', url: '/v1/responses', body: BODY },
      { custom_id: 'df-b', method: 'POST', url: '/v1/responses', body: BODY },
    ]);
    expect(create).toEqual({
      method: 'POST',
      url: 'https://api.openai.com/v1/batches',
      authorization: `Bearer ${KEY}`,
      json: {
        input_file_id: OPENAI_INPUT_FILE,
        endpoint: '/v1/responses',
        completion_window: '24h',
      },
    });
  });

  it('deletes the upload a refused job would have read, and says the job was refused', async () => {
    const { calls, impl } = openAiBatchApi({ createStatus: 429 });
    const transport = new OpenAiBatchTransport({ apiKey: KEY, fetchImpl: impl });

    await expect(transport.create([{ customId: 'df-a', params: BODY }])).rejects.toBeInstanceOf(
      OpenAiRequestError,
    );
    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ['POST', 'https://api.openai.com/v1/files'],
      ['POST', 'https://api.openai.com/v1/batches'],
      ['DELETE', `https://api.openai.com/v1/files/${OPENAI_INPUT_FILE}`],
    ]);
  });

  it('creates no job over an upload the remote refused', async () => {
    const { calls, impl } = openAiBatchApi({ uploadStatus: 500 });
    const transport = new OpenAiBatchTransport({ apiKey: KEY, fetchImpl: impl });

    await expect(transport.create([{ customId: 'df-a', params: BODY }])).rejects.toBeInstanceOf(
      OpenAiRequestError,
    );
    expect(calls).toHaveLength(1);
  });

  it('bounds a request by the output ceiling it names, at the cache-write rate', () => {
    const transport = new OpenAiBatchTransport({ apiKey: KEY });

    expect(transport.bound(BODY)).toEqual({
      model: 'gpt-6-luna',
      outputTokens: 300,
      cacheWrite: true,
      cacheWriteTtl: '5m',
    });
  });
});

describe('reading where a job stands', () => {
  it('reads every status short of an end as still working', async () => {
    for (const status of ['validating', 'in_progress', 'finalizing', 'cancelling', 'a-new-state']) {
      const { impl } = openAiBatchApi({ statuses: [status] });
      const transport = new OpenAiBatchTransport({ apiKey: KEY, fetchImpl: impl });

      expect(await transport.poll(OPENAI_BATCH_ID)).toEqual({ state: 'working' });
    }
  });

  it('reads a completed, expired or cancelled job as ended, with both of its files', async () => {
    for (const status of ['completed', 'expired', 'cancelled']) {
      const { impl } = openAiBatchApi({ statuses: [status], output: [], errors: [] });
      const transport = new OpenAiBatchTransport({ apiKey: KEY, fetchImpl: impl });

      expect(await transport.poll(OPENAI_BATCH_ID)).toEqual({
        state: 'ended',
        sources: [OPENAI_OUTPUT_FILE, OPENAI_ERROR_FILE],
      });
    }
  });

  it('reads only the file a job actually names', async () => {
    const { impl } = openAiBatchApi({ statuses: ['completed'], output: [] });
    const transport = new OpenAiBatchTransport({ apiKey: KEY, fetchImpl: impl });

    expect(await transport.poll(OPENAI_BATCH_ID)).toEqual({
      state: 'ended',
      sources: [OPENAI_OUTPUT_FILE],
    });
  });

  it('reads a job whose input failed validation as refused whole, with the reason', async () => {
    const { impl } = openAiBatchApi({
      statuses: ['failed'],
      batchErrors: { object: 'list', data: [{ code: 'invalid_request', message: 'bad', line: 1 }] },
    });
    const transport = new OpenAiBatchTransport({ apiKey: KEY, fetchImpl: impl });

    const poll = await transport.poll(OPENAI_BATCH_ID);

    expect(poll.state).toBe('refused');
    expect(poll.state === 'refused' ? poll.detail : '').toContain('invalid_request');
  });
});

describe('reading what a job returned', () => {
  it('turns each line into its outcome, keyed by custom_id and in the order the files hold them', async () => {
    const answer = responsesAnswer('{"description":"b"}');
    const { impl } = openAiBatchApi({
      output: [
        outputLine('df-b', answer),
        outputLine('df-c', { error: { message: 'rate limited' } }, 429),
      ],
      errors: [errorLine('df-a', 'batch_expired'), errorLine('df-d', 'server_error')],
    });
    const transport = new OpenAiBatchTransport({ apiKey: KEY, fetchImpl: impl });

    const results = await transport.results([OPENAI_OUTPUT_FILE, OPENAI_ERROR_FILE]);

    expect(results.map((result) => [result.customId, result.type])).toEqual([
      ['df-b', 'succeeded'],
      ['df-c', 'errored'],
      ['df-a', 'expired'],
      ['df-d', 'errored'],
    ]);
    expect(results[0]).toEqual({ customId: 'df-b', type: 'succeeded', message: answer });
    expect(results[1]?.type === 'errored' ? results[1].detail : '').toContain('429');
    expect(results[3]?.type === 'errored' ? results[3].detail : '').toContain('server_error');
  });

  it('drops a line that will not parse rather than failing the read', async () => {
    const { impl } = openAiBatchApi({
      output: [{ not: 'a batch line' }, outputLine('df-a', responsesAnswer('{}'))],
    });
    const transport = new OpenAiBatchTransport({ apiKey: KEY, fetchImpl: impl });

    const results = await transport.results([OPENAI_OUTPUT_FILE]);

    expect(results.map((result) => result.customId)).toEqual(['df-a']);
  });

  it('reads an answer and its usage the way the synchronous route reads them', () => {
    const transport = new OpenAiBatchTransport({ apiKey: KEY });
    const answer = responsesAnswer('{"description":"a pool"}', {
      input_tokens: 1200,
      output_tokens: 80,
      input_tokens_details: { cached_tokens: 200 },
      output_tokens_details: { reasoning_tokens: 0 },
    });

    expect(transport.answerOf(answer)).toEqual({ description: 'a pool' });
    // Priced under the model the stored request named, not the snapshot the response reports.
    expect(transport.chargeOf(answer, BODY)).toEqual({
      model: 'gpt-6-luna',
      usage: {
        inputTokens: 1000,
        outputTokens: 80,
        cacheCreationTokens: 0,
        cacheReadTokens: 200,
        thinkingTokens: 0,
      },
    });
    expect(transport.chargeOf(answer, undefined).model).toBe('gpt-6-luna-snapshot');
  });

  it('refuses an answer the model declined, as the synchronous route does', () => {
    const transport = new OpenAiBatchTransport({ apiKey: KEY });
    const refused = {
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }],
    };

    expect(() => transport.answerOf(refused)).toThrow(/refused/);
  });
});
