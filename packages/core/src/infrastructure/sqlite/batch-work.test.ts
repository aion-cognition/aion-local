import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  enqueueBatchWork,
  outstandingBatchIds,
  pendingBatchWork,
  readBatchWork,
  reencodePendingBatchWork,
} from './batch-work.js';
import { SqliteStore } from './database.js';
import type { GenerationProvider } from '../providers/types.js';

/**
 * Which provider a batch row belongs to: what a substrate written before the column reads as,
 * which rows a switch may re-encode, and which rows each provider's pass sees.
 */

const SUBSTRATE = 'substrate-now';
const NOW = new Date('2026-09-28T10:00:00.000Z');

/** The table exactly as builds before the provider column created it. */
const TABLE_BEFORE_PROVIDER = `CREATE TABLE batch_work (
  work_key TEXT PRIMARY KEY,
  durable_key TEXT NOT NULL,
  substrate_id TEXT NOT NULL,
  surface TEXT NOT NULL,
  revalidation_json TEXT NOT NULL,
  request_json TEXT NOT NULL,
  frame_version TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'submitted', 'applied', 'discarded', 'failed')),
  batch_id TEXT,
  reservation_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  enqueued_at TEXT NOT NULL,
  submitted_at TEXT,
  settled_at TEXT
)`;

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-batch-work-'));
  path = join(dir, 'aion.sqlite');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('a substrate written before rows named their provider', () => {
  it('reads every existing row as Anthropic, the only provider that lane had', () => {
    const before = new Database(path);
    before.exec(TABLE_BEFORE_PROVIDER);
    before
      .prepare(
        `INSERT INTO batch_work (work_key, durable_key, substrate_id, surface, revalidation_json,
           request_json, state, batch_id, enqueued_at)
         VALUES ('df-old', 'df-old', ?, 'judge', '{}', '{}', 'submitted', 'msgbatch_old', ?)`,
      )
      .run(SUBSTRATE, NOW.toISOString());
    before.close();

    // Twice, because a second open must find the column there rather than add it again.
    for (let open = 0; open < 2; open += 1) {
      const store = new SqliteStore({ filePath: path });
      try {
        expect(readBatchWork(store.db, 'df-old')).toMatchObject({
          provider: 'anthropic',
          state: 'submitted',
          batchId: 'msgbatch_old',
        });
        expect(outstandingBatchIds(store.db, SUBSTRATE, 'anthropic')).toEqual(['msgbatch_old']);
        expect(outstandingBatchIds(store.db, SUBSTRATE, 'openai')).toEqual([]);
      } finally {
        store.close();
      }
    }
  });
});

describe('re-encoding owed work for the provider selected now', () => {
  let store: SqliteStore;

  function owe(
    workKey: string,
    provider: GenerationProvider,
    substrateId: string = SUBSTRATE,
  ): void {
    enqueueBatchWork(store.db, {
      workKey,
      durableKey: `durable:${workKey}`,
      substrateId,
      surface: 'judge',
      revalidation: { pair: workKey },
      request: { encodedFor: provider },
      frameVersion: 'frame-1',
      provider,
      now: NOW,
    });
  }

  function reencode(workKey: string): boolean {
    return reencodePendingBatchWork(store.db, {
      workKey,
      substrateId: SUBSTRATE,
      provider: 'openai',
      request: { encodedFor: 'openai' },
      frameVersion: 'frame-2',
    });
  }

  beforeEach(() => {
    store = new SqliteStore({ filePath: path });
  });

  afterEach(() => {
    store.close();
  });

  it('rewrites a pending row of the other provider and keeps everything that names it', () => {
    owe('pair-a', 'anthropic');
    const before = readBatchWork(store.db, 'pair-a');

    expect(reencode('pair-a')).toBe(true);

    expect(readBatchWork(store.db, 'pair-a')).toEqual({
      ...before,
      provider: 'openai',
      request: { encodedFor: 'openai' },
      frameVersion: 'frame-2',
    });
  });

  it('leaves a row the other provider already holds, one already on this provider, and another substrate', () => {
    owe('pair-held', 'anthropic');
    store.db
      .prepare(
        `UPDATE batch_work SET state = 'submitted', batch_id = 'msgbatch_1' WHERE work_key = ?`,
      )
      .run('pair-held');
    owe('pair-same', 'openai');
    owe('pair-elsewhere', 'anthropic', 'substrate-before-the-reset');

    expect(reencode('pair-held')).toBe(false);
    expect(reencode('pair-same')).toBe(false);
    expect(reencode('pair-elsewhere')).toBe(false);
    expect(readBatchWork(store.db, 'pair-held')?.request).toEqual({ encodedFor: 'anthropic' });
    expect(readBatchWork(store.db, 'pair-elsewhere')?.provider).toBe('anthropic');
  });

  it("hands each provider's pass only the rows encoded for it", () => {
    owe('pair-anthropic', 'anthropic');
    owe('pair-openai', 'openai');

    const keys = (provider?: GenerationProvider): string[] =>
      pendingBatchWork(store.db, SUBSTRATE, 10, provider).map((item) => item.workKey);
    expect(keys('openai')).toEqual(['pair-openai']);
    expect(keys('anthropic')).toEqual(['pair-anthropic']);
    expect(keys()).toEqual(['pair-anthropic', 'pair-openai']);
  });
});
