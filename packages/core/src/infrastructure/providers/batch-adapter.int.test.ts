import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { cancelMessageBatch, retrieveMessageBatch } from './anthropic-batches.js';
import { DEFAULT_ANTHROPIC_MODEL } from './anthropic-provider.js';
import {
  consumeBatchWork,
  submitBatchWork,
  type BatchAdapterDeps,
  type BatchWorkHandler,
} from './batch-adapter.js';
import { openLogger } from '../logging/logger.js';
import { enqueueBatchWork, readBatchWork } from '../sqlite/batch-work.js';
import { SqliteStore, type SqliteHandle } from '../sqlite/database.js';

/**
 * One real batch, end to end, against the live API.
 *
 * The durable half is asserted whatever the remote does: the request is accepted, its identity
 * is written down, and the work reads as outstanding rather than done. The round trip is then
 * polled for a bounded time. Batches are documented to take up to 24 hours, so a run where it
 * does not come back inside that window cancels the batch, says so, and asserts nothing about
 * an answer it never saw. The adapter's own branches are proven against injected results in
 * `batch-adapter.test.ts`, which is where the mechanics live.
 */

const API_KEY = (process.env.AION_ANTHROPIC_API_KEY ?? '').trim();
const MODEL = process.env.AION_ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_MODEL;
const SUBSTRATE = 'batch-int-substrate';
const WORK_KEY = 'batch-int-probe';

/** How long one run waits for a batch that usually takes minutes. */
const POLL_BUDGET_MS = 150_000;
const POLL_INTERVAL_MS = 5_000;

let dir: string;
let store: SqliteStore;
let db: SqliteHandle;
let applied: unknown[];

function handler(): BatchWorkHandler {
  return {
    surface: 'batch-probe',
    isCurrent: () => true,
    apply: (_item, answer) => {
      applied.push(answer);
      return Promise.resolve();
    },
  };
}

function deps(): BatchAdapterDeps {
  return {
    db,
    substrateId: SUBSTRATE,
    client: { apiKey: API_KEY },
    handlers: [handler()],
    logger: openLogger({ filePath: join(dir, 'aion.jsonl'), level: 'fatal' }),
  };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-batch-int-'));
  store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  ({ db } = store);
  applied = [];
});

afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(API_KEY === '')('one batch against the live API', () => {
  it('submits, stays outstanding, and applies the answer by identity when it lands', async () => {
    enqueueBatchWork(db, {
      workKey: WORK_KEY,
      substrateId: SUBSTRATE,
      surface: 'batch-probe',
      revalidation: { probe: WORK_KEY },
      request: {
        model: MODEL,
        max_tokens: 64,
        system:
          'Answer with one JSON value and nothing else: no prose, no code fence. ' +
          'The value must satisfy {"type":"object","properties":{"answer":{"type":"string"}},' +
          '"required":["answer"]}.',
        messages: [{ role: 'user', content: 'Set answer to the word ready.' }],
      },
      now: new Date(),
    });

    const submission = await submitBatchWork(deps());

    expect(submission.submitted).toBe(1);
    expect(submission.batchId).toEqual(expect.any(String));
    // Submission is not completion, and the row says so.
    expect(readBatchWork(db, WORK_KEY)).toMatchObject({
      state: 'submitted',
      batchId: submission.batchId,
    });
    expect(applied).toEqual([]);

    const batchId = submission.batchId ?? '';
    const deadline = Date.now() + POLL_BUDGET_MS;
    let ended = false;
    while (Date.now() < deadline) {
      const status = await retrieveMessageBatch({ apiKey: API_KEY }, batchId);
      if (status.processingStatus === 'ended') {
        ended = true;
        break;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, POLL_INTERVAL_MS);
      });
    }

    if (!ended) {
      await cancelMessageBatch({ apiKey: API_KEY }, batchId);
      console.log(
        `batch ${batchId} did not end inside ${String(POLL_BUDGET_MS / 1000)}s; cancelled, ` +
          'and this run asserts nothing about an answer it never saw',
      );
      return;
    }

    const report = await consumeBatchWork(deps());

    console.log(`batch ${batchId} consumed: ${JSON.stringify(report)}`);
    expect(report.applied).toBe(1);
    expect(applied).toHaveLength(1);
    expect(readBatchWork(db, WORK_KEY)?.state).toBe('applied');
  }, 300_000);
});
