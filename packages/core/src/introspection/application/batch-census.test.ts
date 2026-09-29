import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readBatchDemand } from './batch-census.js';
import { BATCH_SETTLEMENT_OPERATION } from './operations/batch-settlement.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import type { Config } from '../../infrastructure/config/schema.js';
import type { GenerationProvider } from '../../infrastructure/providers/types.js';
import { enqueueBatchWork, markBatchSubmitted } from '../../infrastructure/sqlite/batch-work.js';
import { SqliteStore, type SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { recordOperationRun } from '../../infrastructure/sqlite/introspection-counters.js';
import { markLedgerApplied } from '../../infrastructure/sqlite/ops-ledger.js';
import { beginSubstratePairing } from '../../infrastructure/sqlite/publication-control.js';
import { reserveGenerationSpend } from '../../infrastructure/sqlite/spend-ledger.js';

/**
 * The batch lane's census from durable rows alone: what is owed, who holds it, what nothing can
 * move yet, and how long the actionable part has waited since it was owed, sent or last checked.
 */

const OWED_AT = new Date('2026-09-28T17:33:00.000Z');
const NOW = new Date('2026-09-29T04:00:00.000Z');
const MINUTE_MS = 60 * 1000;
const CEILING_USD = DEFAULTS.anthropic.dailyCeilingUsd;

let dir: string;
let path: string;
let store: SqliteStore;
let db: SqliteHandle;
let substrateId: string;

function config(
  provider: GenerationProvider,
  keys: { readonly anthropic?: string; readonly openai?: string },
): Config {
  return {
    ...DEFAULTS,
    generation: { ...DEFAULTS.generation, provider },
    anthropic: { ...DEFAULTS.anthropic, apiKey: keys.anthropic ?? '' },
    openai: { ...DEFAULTS.openai, apiKey: keys.openai ?? '' },
  };
}

const OPENAI_ONLY = config('openai', { openai: 'sk-openai-test' });

function owe(workKey: string, provider: GenerationProvider, at: Date = OWED_AT): void {
  enqueueBatchWork(db, {
    workKey,
    substrateId,
    surface: 'judge',
    revalidation: {},
    request: { model: 'gpt-6-luna', max_output_tokens: 64, input: [] },
    provider,
    now: at,
  });
}

function commit(usd: number): void {
  reserveGenerationSpend(db, {
    surface: 'test',
    route: 'messages',
    maxUsd: usd,
    priced: true,
    ceilingUsd: CEILING_USD,
    now: NOW,
  });
}

function send(workKeys: readonly string[], provider: GenerationProvider, at: Date): void {
  markBatchSubmitted(db, workKeys, `batch-${provider}`, at, undefined, provider);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-batch-census-'));
  path = join(dir, 'aion.sqlite');
  store = new SqliteStore({ filePath: path });
  ({ db } = store);
  ({ substrateId } = beginSubstratePairing(db, 1));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the batch lane census', () => {
  it('reads an empty lane as measured and owing nothing', () => {
    expect(readBatchDemand(db, OPENAI_ONLY, NOW)).toMatchObject({
      availability: 'measured',
      sendable: 0,
      obsolete: 0,
      outstanding: 0,
      localWaitMs: undefined,
      remoteWaitMs: undefined,
    });
  });

  it('measures never-sent work from when it was owed while the pump has not checked since', () => {
    owe('a', 'openai');
    owe('b', 'openai', new Date(OWED_AT.getTime() + 10 * MINUTE_MS));
    recordOperationRun(db, BATCH_SETTLEMENT_OPERATION, '2026-09-28T10:21:00.000Z');

    expect(readBatchDemand(db, OPENAI_ONLY, NOW)).toMatchObject({
      sendable: 2,
      blocked: 0,
      lastCheckedAt: '2026-09-28T10:21:00.000Z',
      localWaitMs: NOW.getTime() - OWED_AT.getTime(),
    });
  });

  it('measures from the last check once the pump has looked after the work was owed', () => {
    owe('a', 'openai');
    const checked = new Date(NOW.getTime() - 20 * MINUTE_MS);
    recordOperationRun(db, BATCH_SETTLEMENT_OPERATION, checked.toISOString());

    expect(readBatchDemand(db, OPENAI_ONLY, NOW).localWaitMs).toBe(20 * MINUTE_MS);
  });

  it('keeps the same reading across a reopen, since every input is durable', () => {
    owe('a', 'openai');
    const before = readBatchDemand(db, OPENAI_ONLY, NOW);
    store.close();
    store = new SqliteStore({ filePath: path });
    ({ db } = store);

    expect(readBatchDemand(db, OPENAI_ONLY, NOW)).toEqual(before);
  });

  it('counts never-sent work for the other provider as work a run can discard', () => {
    owe('stranded', 'anthropic');

    expect(readBatchDemand(db, OPENAI_ONLY, NOW)).toMatchObject({
      sendable: 0,
      obsolete: 1,
      localWaitMs: NOW.getTime() - OWED_AT.getTime(),
    });
  });

  it('holds never-sent work back without the selected key, and scores no wait for it', () => {
    owe('a', 'openai');
    owe('stranded', 'anthropic');

    expect(readBatchDemand(db, config('openai', {}), NOW)).toMatchObject({
      sendable: 0,
      blocked: 1,
      blockedBy: 'missing_key',
      obsolete: 1,
    });
  });

  it('holds never-sent work back on a day whose ceiling cannot hold the next batch', () => {
    owe('a', 'openai');
    // A millionth of a dollar short, which is where a real day stops: the hold that would cross
    // the ceiling is refused, so nothing ever fills it to the cent.
    commit(CEILING_USD - 0.000001);

    expect(readBatchDemand(db, OPENAI_ONLY, NOW)).toMatchObject({
      sendable: 0,
      blocked: 1,
      blockedBy: 'spent_ceiling',
      localWaitMs: undefined,
    });
  });

  it('reads the same work as sendable while the day has room for the batch', () => {
    owe('a', 'openai');
    commit(CEILING_USD - 1);

    expect(readBatchDemand(db, OPENAI_ONLY, NOW)).toMatchObject({
      sendable: 1,
      blocked: 0,
      blockedBy: undefined,
    });
  });

  it('counts a settled job whose vendor files could not be deleted, from the pass that tried', () => {
    markLedgerApplied(db, 'batch_release:openai:batch_done', {
      batchId: 'batch_done',
      released: false,
    });
    markLedgerApplied(db, 'batch_release:openai:batch_clean', {
      batchId: 'batch_clean',
      released: true,
    });
    const tried = new Date(NOW.getTime() - 30 * MINUTE_MS);
    recordOperationRun(db, BATCH_SETTLEMENT_OPERATION, tried.toISOString());

    expect(readBatchDemand(db, OPENAI_ONLY, NOW)).toMatchObject({
      sendable: 0,
      outstanding: 0,
      releases: 1,
      unkeyedReleases: 0,
      releaseWaitMs: 30 * MINUTE_MS,
    });
    expect(readBatchDemand(db, config('openai', {}), NOW)).toMatchObject({
      releases: 0,
      unkeyedReleases: 1,
      releaseWaitMs: undefined,
    });
  });

  it('tells remote work from never-sent work, and remote work nobody can read from both', () => {
    owe('at-openai', 'openai');
    owe('at-anthropic', 'anthropic');
    const sentAt = new Date(NOW.getTime() - 45 * MINUTE_MS);
    send(['at-openai'], 'openai', sentAt);
    send(['at-anthropic'], 'anthropic', sentAt);

    expect(readBatchDemand(db, OPENAI_ONLY, NOW)).toMatchObject({
      sendable: 0,
      outstanding: 1,
      unreadable: 1,
      localWaitMs: undefined,
      remoteWaitMs: 45 * MINUTE_MS,
    });
  });
});
