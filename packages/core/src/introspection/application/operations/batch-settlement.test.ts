import type { Driver } from 'neo4j-driver';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { batchSettlementOperation } from './batch-settlement.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import type { Config } from '../../../infrastructure/config/schema.js';
import type { Logger } from '../../../infrastructure/logging/logger.js';
import type { BatchWorkHandler } from '../../../infrastructure/providers/batch-adapter.js';
import {
  OPENAI_BATCH_ID,
  openAiBatchApi,
  type RecordedCall,
} from '../../../infrastructure/providers/test-support/openai-batch-api.fixture.js';
import type { GenerationProvider, Provider } from '../../../infrastructure/providers/types.js';
import { enqueueBatchWork, readBatchWork } from '../../../infrastructure/sqlite/batch-work.js';
import { SqliteStore, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import { getLedgerEntry, markLedgerApplied } from '../../../infrastructure/sqlite/ops-ledger.js';
import { beginSubstratePairing } from '../../../infrastructure/sqlite/publication-control.js';
import type { OperationContext, OperationOutcome } from '../../domain/operation.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';

/**
 * Which provider each half of the pump uses. Submission follows the installation's selection and
 * that provider's key. Settlement follows the provider each job was sent to and that provider's
 * key, whatever is selected now, and a job whose key is gone is reported rather than finished or
 * sent again. Both remotes are scripted; nothing leaves the process.
 */

const ANTHROPIC_KEY = 'sk-ant-test';
const OPENAI_KEY = 'sk-openai-test';
const ANTHROPIC_BATCHES = 'https://api.anthropic.com/v1/messages/batches';
const NOW = new Date('2026-09-28T10:00:00.000Z');

let dir: string;
let store: SqliteStore;
let db: SqliteHandle;
let substrateId: string;
let applied: string[];
let calls: RecordedCall[];

function silentLogger(): Logger {
  const noop = (): void => {
    // A test logger that prints nothing, on purpose.
  };
  return { debug: noop, info: noop, warn: noop, error: noop } as unknown as Logger;
}

function handler(): BatchWorkHandler {
  return {
    surface: 'judge',
    isCurrent: () => true,
    apply: (item) => {
      applied.push(item.workKey);
      return Promise.resolve();
    },
  };
}

/**
 * Anthropic's batch endpoints answered from a script, and OpenAI's by the shared fake. Every call
 * to either is recorded with the credential header it carried.
 */
function bothRemotes(): typeof fetch {
  const openAi = openAiBatchApi();
  ({ calls } = openAi);
  return (async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (!url.startsWith('https://api.anthropic.com')) {
      return openAi.impl(input, init);
    }
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ method: init?.method ?? 'GET', url, authorization: headers['x-api-key'] });
    if (url === ANTHROPIC_BATCHES) {
      return Response.json({ id: 'msgbatch_new', processing_status: 'in_progress' });
    }
    if (url.endsWith('/results')) {
      return new Response(
        JSON.stringify({
          custom_id: 'pair-old',
          result: {
            type: 'succeeded',
            message: {
              model: 'claude-haiku-4-5',
              content: [{ type: 'text', text: '{"verdict":"old"}' }],
              usage: { input_tokens: 10, output_tokens: 5 },
            },
          },
        }),
      );
    }
    return Response.json({
      id: 'msgbatch_old',
      processing_status: 'ended',
      results_url: `${ANTHROPIC_BATCHES}/msgbatch_old/results`,
    });
  }) as typeof fetch;
}

function owe(workKey: string, provider: GenerationProvider): void {
  enqueueBatchWork(db, {
    workKey,
    substrateId,
    surface: 'judge',
    revalidation: {},
    request:
      provider === 'openai'
        ? { model: 'gpt-6-luna', max_output_tokens: 64, input: [] }
        : { model: 'claude-haiku-4-5', max_tokens: 64, messages: [] },
    provider,
    now: NOW,
  });
}

/** An Anthropic job submitted before the installation switched, as its own service left it. */
function oweAtAnthropic(workKey: string): void {
  owe(workKey, 'anthropic');
  db.prepare(
    `UPDATE batch_work SET state = 'submitted', batch_id = 'msgbatch_old' WHERE work_key = ?`,
  ).run(workKey);
}

function run(
  provider: GenerationProvider,
  keys: { readonly anthropic?: string; readonly openai?: string },
): Promise<OperationOutcome> {
  const config: Config = {
    ...DEFAULTS,
    generation: { ...DEFAULTS.generation, provider },
    anthropic: { ...DEFAULTS.anthropic, apiKey: keys.anthropic ?? '' },
    openai: { ...DEFAULTS.openai, apiKey: keys.openai ?? '' },
  };
  const ctx: OperationContext = {
    driver: {} as Driver,
    db,
    config,
    logger: silentLogger(),
    provider: {} as Provider,
    health: healthFixture(),
    now: NOW,
    signal: new AbortController().signal,
  };
  // Only the run is exercised here; the scale shapes the relevance alone.
  return batchSettlementOperation([() => handler()], { fullWaitMs: 0 }).run(ctx);
}

function anthropicCalls(): RecordedCall[] {
  return calls.filter((call) => call.url.startsWith('https://api.anthropic.com'));
}

function openAiCalls(): RecordedCall[] {
  return calls.filter((call) => call.url.startsWith('https://api.openai.com'));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-batch-settlement-'));
  store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  ({ db } = store);
  ({ substrateId } = beginSubstratePairing(db, 1));
  applied = [];
  vi.stubGlobal('fetch', bothRemotes());
});

afterEach(() => {
  vi.unstubAllGlobals();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('an installation that switched to OpenAI with an Anthropic job still out', () => {
  it('settles the Anthropic job through Anthropic with its key, and sends new work to OpenAI', async () => {
    oweAtAnthropic('pair-old');
    owe('pair-new', 'openai');

    const outcome = await run('openai', { anthropic: ANTHROPIC_KEY, openai: OPENAI_KEY });

    expect(applied).toEqual(['pair-old']);
    expect(readBatchWork(db, 'pair-old')?.state).toBe('applied');
    // The Anthropic job is read, never re-created, and only with the Anthropic key.
    expect(anthropicCalls().map((call) => [call.method, call.authorization])).toEqual([
      ['GET', ANTHROPIC_KEY],
      ['GET', ANTHROPIC_KEY],
    ]);
    expect(openAiCalls().every((call) => call.authorization === `Bearer ${OPENAI_KEY}`)).toBe(true);
    expect(readBatchWork(db, 'pair-new')).toMatchObject({
      state: 'submitted',
      batchId: OPENAI_BATCH_ID,
      provider: 'openai',
    });
    expect(outcome.detail).toContain('1 applied');
    expect(outcome.detail).toContain('1 submitted to openai');
  });

  it('reports the Anthropic job it cannot read without that key, and neither finishes nor resends it', async () => {
    oweAtAnthropic('pair-old');
    owe('pair-new', 'openai');

    const outcome = await run('openai', { openai: OPENAI_KEY });

    expect(anthropicCalls()).toEqual([]);
    expect(readBatchWork(db, 'pair-old')).toMatchObject({
      state: 'submitted',
      batchId: 'msgbatch_old',
      provider: 'anthropic',
    });
    expect(outcome.detail).toContain(
      '1 outstanding at anthropic stay unread without AION_ANTHROPIC_API_KEY',
    );
    // New work on the selected provider continues.
    expect(readBatchWork(db, 'pair-new')?.state).toBe('submitted');
    expect(outcome.status).toBe('applied');
  });

  it('discards never-sent work still encoded for Anthropic, and sends it nowhere', async () => {
    owe('pair-stranded', 'anthropic');

    const outcome = await run('openai', { anthropic: ANTHROPIC_KEY, openai: OPENAI_KEY });

    expect(calls).toEqual([]);
    expect(readBatchWork(db, 'pair-stranded')).toMatchObject({
      state: 'discarded',
      provider: 'anthropic',
    });
    expect(outcome.status).toBe('noop');
    expect(outcome.detail).toContain(
      '1 never-sent rows encoded for anthropic discarded; a producer that asks again ' +
        're-encodes them for openai',
    );
  });
});

describe('the selected provider and its key', () => {
  it('submits nothing and says why when the selected provider has no key', async () => {
    owe('pair-new', 'openai');

    const outcome = await run('openai', { anthropic: ANTHROPIC_KEY });

    expect(calls).toEqual([]);
    expect(readBatchWork(db, 'pair-new')?.state).toBe('pending');
    expect(outcome.status).toBe('noop');
    expect(outcome.detail).toContain(
      'nothing submitted: AION_GENERATION_PROVIDER=openai needs AION_OPENAI_API_KEY',
    );
  });

  it('keeps an Anthropic installation on Anthropic and never mentions the OpenAI key', async () => {
    owe('pair-new', 'anthropic');

    const outcome = await run('anthropic', { anthropic: ANTHROPIC_KEY });

    expect(openAiCalls()).toEqual([]);
    expect(anthropicCalls()).toEqual([
      { method: 'POST', url: ANTHROPIC_BATCHES, authorization: ANTHROPIC_KEY },
    ]);
    expect(readBatchWork(db, 'pair-new')).toMatchObject({
      state: 'submitted',
      batchId: 'msgbatch_new',
    });
    expect(outcome.detail).not.toContain('OPENAI');
  });
});

describe('a settled job whose vendor files an earlier pass could not delete', () => {
  const RELEASE_KEY = `batch_release:openai:${OPENAI_BATCH_ID}`;

  beforeEach(() => {
    markLedgerApplied(db, RELEASE_KEY, { batchId: OPENAI_BATCH_ID, released: false });
  });

  it('retries the deletion with that key though no row is left outstanding', async () => {
    const outcome = await run('openai', { openai: OPENAI_KEY });

    expect(openAiCalls().filter((call) => call.method === 'DELETE')).toHaveLength(1);
    expect(getLedgerEntry(db, RELEASE_KEY)?.summary).toMatchObject({ released: true });
    expect(outcome.status).toBe('applied');
    expect(outcome.detail).toContain("1 settled jobs' files deleted at the vendor on a retry");
  });

  it('calls nobody without that key, and says the files stay', async () => {
    const outcome = await run('openai', {});

    expect(calls).toEqual([]);
    expect(getLedgerEntry(db, RELEASE_KEY)?.summary).toMatchObject({ released: false });
    expect(outcome.status).toBe('noop');
    expect(outcome.detail).toContain(
      "1 settled jobs' files at openai stay undeleted without AION_OPENAI_API_KEY",
    );
  });
});
