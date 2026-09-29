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
import { beginSubstratePairing } from '../../infrastructure/sqlite/publication-control.js';
import { reserveGenerationSpend } from '../../infrastructure/sqlite/spend-ledger.js';

/**
 * The batch lane's census from durable rows alone: what is owed, who holds it, what nothing can
 * move yet, and how long the actionable part has waited since it was owed, sent or last checked.
 */

const OWED_AT = new Date('2026-09-28T17:33:00.000Z');
const NOW = new Date('2026-09-29T04:00:00.000Z');
const MINUTE_MS = 60 * 1000;

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
    request: {},
    provider,
    now: at,
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

  it('holds never-sent work back on a day whose ceiling is spent', () => {
    owe('a', 'openai');
    reserveGenerationSpend(db, {
      surface: 'test',
      route: 'messages',
      maxUsd: DEFAULTS.anthropic.dailyCeilingUsd,
      priced: true,
      ceilingUsd: DEFAULTS.anthropic.dailyCeilingUsd,
      now: NOW,
    });

    expect(readBatchDemand(db, OPENAI_ONLY, NOW)).toMatchObject({
      sendable: 0,
      blocked: 1,
      blockedBy: 'spent_ceiling',
      localWaitMs: undefined,
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
