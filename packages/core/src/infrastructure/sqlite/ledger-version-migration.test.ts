import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openSqliteHandle, SqliteStore, type SqliteHandle } from './database.js';
import { migrateUnversionedLedgerKeys } from './ledger-version-migration.js';
import { getLedgerEntry, listLedgerKeys, markLedgerApplied } from './ops-ledger.js';

/**
 * The rows the ledger already holds, written before the key carried a version. They are what
 * stands between a version fork and a substrate that reports every episode as unenriched.
 */

let store: SqliteStore;
let dataDir: string;
let filePath: string;

function keys(db: SqliteHandle): string[] {
  return listLedgerKeys(db, '');
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'aion-ledger-version-'));
  filePath = join(dataDir, 'aion.sqlite');
  store = new SqliteStore({ filePath });
});

afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('migrateUnversionedLedgerKeys', () => {
  it('rewrites both reflection families into the version that wrote them', () => {
    markLedgerApplied(store.db, 'reflection:orchestrator:episode-1', { stages: [] });
    markLedgerApplied(store.db, 'reflection:stage:cognitive:episode-1', { status: 'ok' });
    markLedgerApplied(store.db, 'reflection:stage:semantic-relationships:episode-2');

    const report = migrateUnversionedLedgerKeys(store.db);

    expect(report).toEqual({ orchestratorKeys: 1, stageKeys: 2 });
    expect(keys(store.db)).toEqual([
      'reflection:orchestrator:v1:episode-1',
      'reflection:stage:v1:cognitive:episode-1',
      'reflection:stage:v1:semantic-relationships:episode-2',
    ]);
  });

  it('carries the summary and the applied time across with the key', () => {
    markLedgerApplied(store.db, 'reflection:orchestrator:episode-1', { stages: ['entities'] });
    const before = getLedgerEntry(store.db, 'reflection:orchestrator:episode-1');

    migrateUnversionedLedgerKeys(store.db);

    expect(getLedgerEntry(store.db, 'reflection:orchestrator:v1:episode-1')).toEqual({
      key: 'reflection:orchestrator:v1:episode-1',
      appliedAt: before?.appliedAt,
      summary: { stages: ['entities'] },
    });
  });

  it('does nothing on a second run', () => {
    markLedgerApplied(store.db, 'reflection:orchestrator:episode-1');
    markLedgerApplied(store.db, 'reflection:stage:cognitive:episode-1');
    migrateUnversionedLedgerKeys(store.db);
    const migrated = keys(store.db);

    const second = migrateUnversionedLedgerKeys(store.db);

    expect(second).toEqual({ orchestratorKeys: 0, stageKeys: 0 });
    expect(keys(store.db)).toEqual(migrated);
  });

  it('leaves every other key family alone', () => {
    const untouched = [
      'association.co_occurs:episode-1',
      'entity.merge:canon-1:dup-1',
      'intro:memory_decay:2026-09-01',
      'reinforcement.co_extraction:episode-1',
      'tier3:pair-1',
    ];
    for (const key of untouched) {
      markLedgerApplied(store.db, key);
    }

    const report = migrateUnversionedLedgerKeys(store.db);

    expect(report).toEqual({ orchestratorKeys: 0, stageKeys: 0 });
    expect(keys(store.db)).toEqual([...untouched].sort());
  });

  it('keeps the versioned row when both spellings of one key exist', () => {
    markLedgerApplied(store.db, 'reflection:orchestrator:episode-1', { from: 'unversioned' });
    markLedgerApplied(store.db, 'reflection:orchestrator:v1:episode-1', { from: 'versioned' });

    const report = migrateUnversionedLedgerKeys(store.db);

    expect(report.orchestratorKeys).toBe(0);
    expect(getLedgerEntry(store.db, 'reflection:orchestrator:v1:episode-1')?.summary).toEqual({
      from: 'versioned',
    });
  });

  it('runs on every open, so a substrate is migrated by opening it', () => {
    markLedgerApplied(store.db, 'reflection:orchestrator:episode-1');
    markLedgerApplied(store.db, 'reflection:stage:entities:episode-1');
    store.close();

    const reopened = openSqliteHandle({ filePath });
    try {
      expect(keys(reopened)).toEqual([
        'reflection:orchestrator:v1:episode-1',
        'reflection:stage:v1:entities:episode-1',
      ]);
    } finally {
      reopened.close();
    }

    store = new SqliteStore({ filePath });
  });
});
