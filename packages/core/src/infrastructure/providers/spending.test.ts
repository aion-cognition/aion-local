import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AnthropicProvider } from './anthropic-provider.js';
import { submitBatchWork, type BatchAdapterDeps } from './batch-adapter.js';
import { isGenerationUnavailable } from './errors.js';
import { conservativeTokens, GenerationSpendGuard } from './spending.js';
import { summarizeApiCalls } from '../sqlite/api-usage.js';
import { enqueueBatchWork, readBatchWork } from '../sqlite/batch-work.js';
import { openSqliteHandle, type SqliteHandle } from '../sqlite/database.js';
import { readSpendDay } from '../sqlite/spend-ledger.js';

/**
 * The daily ceiling, against a real store and with the remote injected.
 *
 * What is provable here is the part that has to hold before anything is sent: one ceiling across
 * both routes, a refusal that reads as generation being unavailable rather than as a failure, a
 * hold replaced by the bill rather than added to it, and a book that survives the process.
 */

const MODEL = 'claude-haiku-4-5';
const NOW = new Date('2026-09-13T10:00:00.000Z');

let dir: string;
let dbPath: string;
let db: SqliteHandle;

function silentLogger(): BatchAdapterDeps['logger'] {
  const noop = (): void => {
    // A test logger that prints nothing, on purpose.
  };
  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
  } as unknown as BatchAdapterDeps['logger'];
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-spending-'));
  dbPath = join(dir, 'aion.sqlite');
  db = openSqliteHandle({ filePath: dbPath });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the shared daily ceiling', () => {
  it('cannot be overcommitted by an ordinary call and a batch submission together', () => {
    // Two guards, one store. This is the shape the service runs in: the provider holds one and
    // the batch pump builds its own, and neither is the place the headroom lives.
    const messages = new GenerationSpendGuard({ db, ceilingUsd: 0.01 });
    const batches = new GenerationSpendGuard({ db, ceilingUsd: 0.01 });
    const tokens = { inputTokens: 1000, outputTokens: 1000 };

    // $0.006 at the ordinary rate, $0.003 at the batch rate.
    const first = messages.hold({
      surface: 'cognitive',
      model: MODEL,
      route: 'messages',
      ...tokens,
      now: NOW,
    });
    const second = batches.hold({
      surface: 'background',
      model: MODEL,
      route: 'batch',
      ...tokens,
      now: NOW,
    });
    const third = messages.hold({
      surface: 'cues',
      model: MODEL,
      route: 'messages',
      ...tokens,
      now: NOW,
    });

    expect('hold' in first).toBe(true);
    expect('hold' in second).toBe(true);
    expect('refused' in third).toBe(true);
    const day = readSpendDay(db, NOW);
    expect(day.committedUsd).toBeCloseTo(0.009, 8);
    expect(day.committedUsd).toBeLessThanOrEqual(0.01);
    expect(day.inFlight).toBe(2);
  });

  it('refuses with the same unavailability a keyless substrate answers with', () => {
    const guard = new GenerationSpendGuard({ db, ceilingUsd: 0.000001 });

    const outcome = guard.hold({
      surface: 'entities',
      model: MODEL,
      route: 'messages',
      inputTokens: 1000,
      outputTokens: 1000,
      now: NOW,
    });

    expect('refused' in outcome).toBe(true);
    if ('refused' in outcome) {
      // The type is what the worker reads to put a job back without spending an attempt, and what
      // recall reads to fall back to the raw query. A new error class would be a failure to both.
      expect(isGenerationUnavailable(outcome.refused)).toBe(true);
      expect(outcome.refused.message).toContain("today's ceiling");
    }
  });

  it('replaces the hold with the bill, and gives back what never reached the wire', () => {
    const guard = new GenerationSpendGuard({ db, ceilingUsd: 5 });
    const tokens = { inputTokens: 1000, outputTokens: 1000 };

    const reconciled = guard.hold({
      surface: 'cognitive',
      model: MODEL,
      route: 'messages',
      ...tokens,
      now: NOW,
    });
    const abandoned = guard.hold({
      surface: 'cognitive',
      model: MODEL,
      route: 'messages',
      ...tokens,
      now: NOW,
    });
    if (!('hold' in reconciled) || !('hold' in abandoned)) {
      throw new Error('the ceiling refused a hold it had room for');
    }
    expect(readSpendDay(db, NOW).committedUsd).toBeCloseTo(0.012, 8);

    reconciled.hold.settle(0.0002, NOW);
    abandoned.hold.release(NOW);

    expect(readSpendDay(db, NOW).committedUsd).toBeCloseTo(0.0002, 8);
    expect(readSpendDay(db, NOW).inFlight).toBe(0);
  });

  it('keeps a hold at its maximum when the charge cannot be sized', () => {
    const guard = new GenerationSpendGuard({ db, ceilingUsd: 5 });

    const held = guard.hold({
      surface: 'cognitive',
      model: MODEL,
      route: 'messages',
      inputTokens: 1000,
      outputTokens: 1000,
      now: NOW,
    });
    if (!('hold' in held)) {
      throw new Error('the ceiling refused a hold it had room for');
    }
    held.hold.settle(undefined, NOW);

    // Unknown is not free: the conservative maximum stands as the day's reading of it.
    expect(readSpendDay(db, NOW).committedUsd).toBeCloseTo(0.006, 8);
  });

  it('records a dispatch on an unpriced model rather than reading it as free', () => {
    const guard = new GenerationSpendGuard({ db, ceilingUsd: 0.000001 });

    const held = guard.hold({
      surface: 'cognitive',
      model: 'a-model-nobody-has-priced',
      route: 'messages',
      inputTokens: 1000,
      outputTokens: 1000,
      now: NOW,
    });

    // A dollar ceiling has nothing to hold an unpriced model against, so the call goes and the
    // day's report says how many such calls it cannot account for.
    expect('hold' in held).toBe(true);
    expect(readSpendDay(db, NOW).unpriced).toBe(1);
  });

  it('counts settled charges and outstanding holds across a restart', () => {
    const guard = new GenerationSpendGuard({ db, ceilingUsd: 5 });
    const tokens = { inputTokens: 1000, outputTokens: 1000 };
    const settled = guard.hold({
      surface: 'cognitive',
      model: MODEL,
      route: 'messages',
      ...tokens,
      now: NOW,
    });
    const outstanding = guard.hold({
      surface: 'background',
      model: MODEL,
      route: 'batch',
      ...tokens,
      now: NOW,
    });
    if (!('hold' in settled) || !('hold' in outstanding)) {
      throw new Error('the ceiling refused a hold it had room for');
    }
    settled.hold.settle(0.0002, NOW);
    db.close();

    db = openSqliteHandle({ filePath: dbPath });

    // $0.0002 charged plus the batch submission still out at its $0.003 maximum.
    const day = readSpendDay(db, NOW);
    expect(day.committedUsd).toBeCloseTo(0.0032, 8);
    expect(day.inFlight).toBe(1);
    // And a re-poll that settles the same hold again reaches the same number rather than twice it.
    const reopened = new GenerationSpendGuard({ db, ceilingUsd: 5 });
    expect(reopened.today(NOW).committedUsd).toBeCloseTo(0.0032, 8);
  });
});

describe('what the ordinary route does before it dispatches', () => {
  it('sends nothing once the day is spent, and bills what it does send', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            content: [{ type: 'text', text: '{}' }],
            usage: {
              input_tokens: 100,
              output_tokens: 20,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          }),
        ),
      ),
    );
    const guard = new GenerationSpendGuard({ db, ceilingUsd: 0.01 });
    const provider = new AnthropicProvider({
      apiKey: 'injected-test-key',
      model: MODEL,
      fetchImpl,
      spending: guard,
      now: () => NOW.getTime(),
    });
    const request = {
      surface: 'cognitive',
      model: MODEL,
      messages: [{ role: 'user' as const, content: 'a record' }],
      schema: { type: 'object' },
      maxTokens: 600,
    };

    await provider.generate(request);

    // The call that went through is on the books at what it cost, not at what it held.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(readSpendDay(db, NOW).committedUsd).toBeCloseTo(0.0002, 8);
    expect(readSpendDay(db, NOW).inFlight).toBe(0);

    // The rest of the day goes somewhere else: another caller's work, charged and settled.
    const rest = guard.hold({
      surface: 'background',
      model: MODEL,
      route: 'messages',
      inputTokens: 9_000,
      outputTokens: 0,
      now: NOW,
    });
    if (!('hold' in rest)) {
      throw new Error('the ceiling refused a hold it had room for');
    }
    rest.hold.settle(0.009, NOW);

    const refused = await provider.generate(request).catch((err: unknown) => err);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(isGenerationUnavailable(refused)).toBe(true);
  });

  it('gives the day its dollars back when the request never reaches a billed response', async () => {
    const provider = new AnthropicProvider({
      apiKey: 'injected-test-key',
      model: MODEL,
      fetchImpl: () => Promise.reject(new Error('the network is down')),
      spending: new GenerationSpendGuard({ db, ceilingUsd: 5 }),
      now: () => NOW.getTime(),
      breakerFailureThreshold: 100,
    });

    await expect(
      provider.generate({
        surface: 'cognitive',
        model: MODEL,
        messages: [{ role: 'user', content: 'a record' }],
        schema: { type: 'object' },
      }),
    ).rejects.toThrow('the network is down');

    expect(readSpendDay(db, NOW).committedUsd).toBe(0);
  });
});

describe('what the batch route does before it submits', () => {
  it('leaves the work queued when the submission would pass the ceiling', async () => {
    const fetchImpl = vi.fn();
    enqueueBatchWork(db, {
      workKey: 'expensive-item',
      substrateId: 'this-substrate',
      surface: 'background',
      revalidation: { revision: 1 },
      now: NOW,
      request: {
        model: MODEL,
        max_tokens: 4096,
        messages: [{ role: 'user', content: 'summarize this' }],
      },
    });

    const report = await submitBatchWork({
      db,
      substrateId: 'this-substrate',
      client: { apiKey: 'injected-test-key', fetchImpl },
      handlers: [],
      logger: silentLogger(),
      spending: new GenerationSpendGuard({ db, ceilingUsd: 0.000001 }),
      now: () => NOW,
    });

    // Not a failure and not a drop: the work is background work, and it waits for a day with
    // room in it.
    expect(report).toEqual({ submitted: 0, batchId: undefined });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(readBatchWork(db, 'expensive-item')?.state).toBe('pending');
    expect(readSpendDay(db, NOW).committedUsd).toBe(0);
    expect(summarizeApiCalls(db, NOW, new Date('2026-09-14T00:00:00.000Z')).days).toEqual([]);
  });
});

describe('the conservative token bound', () => {
  it('reads a prompt as more tokens than it is likely to be, and max_tokens as all of them', () => {
    // Three characters per token against the four the pricing docs estimate, so the hold sits
    // above the bill. The reconcile a moment later is what takes the slack back.
    expect(conservativeTokens(900, 512)).toEqual({ inputTokens: 300, outputTokens: 512 });
    expect(conservativeTokens(0, 0)).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});
