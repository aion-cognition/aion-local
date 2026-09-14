import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { runExtractionExperiment } from './extraction-experiment.js';
import { QUALITY_FIXTURES } from './fixtures.js';
import { AnthropicHaikuClient } from '../../../infrastructure/providers/test-support/anthropic-client.js';
import { openCampaignProducer } from '../../../infrastructure/providers/test-support/campaign-guard.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-F3-execution-review-'));
  vi.stubEnv('AION_F3_CAMPAIGN_LEDGER', join(dir, 'campaign.sqlite'));
  vi.stubEnv('AION_F3_FRAME_OVERRIDE', 'none');
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function response(text: string, outputTokens: number): Response {
  return new Response(
    JSON.stringify({
      content: [{ type: 'text', text }],
      usage: { input_tokens: 200, output_tokens: outputTokens },
    }),
    { status: 200 },
  );
}

async function exercise(fetchImpl: typeof fetch, budget: number) {
  const producer = openCampaignProducer({
    experiment: 'extraction-faithfulness',
    ceilingUsd: 100,
    campaignBudgetUsd: budget,
  });
  try {
    const run = await runExtractionExperiment({
      producer,
      fixtures: QUALITY_FIXTURES.slice(0, 1),
      conditions: ['no-frame'],
      clientFor: (context) => {
        const client = new AnthropicHaikuClient({
          apiKey: 'test-key-never-sent',
          fetchImpl,
          spending: producer.guard,
          recordApiCall: context.recordApiCall,
          ...(context.frameOverride === undefined ? {} : { frameOverride: context.frameOverride }),
        });
        return { generate: client.generate.bind(client), model: 'claude-haiku-4-5' };
      },
    });
    const usage = producer.db
      .prepare('SELECT surface, input_tokens, output_tokens FROM api_calls')
      .all();
    const spend = producer.db
      .prepare('SELECT state, reserved_usd, settled_usd FROM generation_spend')
      .all();
    return { run, usage, spend };
  } finally {
    producer.close();
  }
}

it('preserves dispatch when a bought malformed response exhausts the structured retry budget', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => response('not JSON', 4000));
  const result = await exercise(fetchImpl, 0.04);
  console.log(
    JSON.stringify({
      case: 'paid-first-response-retry-refused',
      fetches: fetchImpl.mock.calls.length,
      ...result,
    }),
  );
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(result.usage).toHaveLength(1);
  expect(result.run.unrun).toHaveLength(1);
  expect(result.run.dispatched).toBe(1);
});

it('keeps a zero-cap refusal distinct from the paid partial attempt', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => response('not JSON', 4000));
  const result = await exercise(fetchImpl, 0);
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(result.usage).toEqual([]);
  expect(result.run.dispatched).toBe(0);
  expect(result.run.refused).toBe(1);
  expect(result.run.unrun).toHaveLength(1);
  expect(result.run.records[0]?.outcome).not.toHaveProperty('valid');
});

it('records both responses when the same structured retry has enough budget', async () => {
  let attempts = 0;
  const fetchImpl = vi.fn<typeof fetch>(async () => {
    attempts += 1;
    return attempts % 2 === 1
      ? response('not JSON', 4000)
      : response('{"entities":[],"nodes":[]}', 20);
  });
  const result = await exercise(fetchImpl, 100);
  expect(fetchImpl).toHaveBeenCalledTimes(4);
  expect(result.usage).toHaveLength(4);
  expect(result.run.dispatched).toBe(2);
  expect(result.run.refused).toBe(0);
  expect(result.run.unrun).toEqual([]);
  expect(
    result.run.records.every(
      (record) => record.outcome.execution === 'dispatched' && record.outcome.valid,
    ),
  ).toBe(true);
});

it('shows that a dispatched transport rejection owes no observed billed-response row', async () => {
  const fetchImpl = vi.fn<typeof fetch>(
    async () => new Response('invalid request', { status: 400 }),
  );
  const result = await exercise(fetchImpl, 100);
  console.log(
    JSON.stringify({
      case: 'transport-not-a-billed-answer',
      fetches: fetchImpl.mock.calls.length,
      ...result,
    }),
  );
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(result.run.dispatched).toBe(2);
  expect(result.usage).toEqual([]);
  // This is the inverse of the live root's current assertion. It is a diagnostic witness,
  // not an instruction to invent usage for rejected HTTP requests.
  expect(result.usage.length >= result.run.dispatched).toBe(false);
});

it('retains schema invalidity when an answer really was received', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => response('{"unexpected":true}', 20));
  const result = await exercise(fetchImpl, 100);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(result.usage).toHaveLength(2);
  expect(result.run.dispatched).toBe(2);
  expect(result.run.refused).toBe(0);
  expect(
    result.run.records.every(
      (record) => record.outcome.execution === 'dispatched' && record.outcome.valid === false,
    ),
  ).toBe(true);
});
