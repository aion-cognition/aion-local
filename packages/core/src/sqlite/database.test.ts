import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_BUSY_TIMEOUT_MS, SqliteStore } from './database.js';

describe('SqliteStore', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-sqlite-'));
    dbPath = join(dir, 'nested', 'aion.sqlite');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the destination directory and opens in WAL mode with busy_timeout set', () => {
    const store = new SqliteStore({ filePath: dbPath });
    try {
      expect(existsSync(dbPath)).toBe(true);
      expect(store.db.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(store.db.pragma('busy_timeout', { simple: true })).toBe(DEFAULT_BUSY_TIMEOUT_MS);
    } finally {
      store.close();
    }
  });

  it('honors a custom busy_timeout', () => {
    const store = new SqliteStore({ filePath: dbPath, busyTimeoutMs: 9000 });
    try {
      expect(store.db.pragma('busy_timeout', { simple: true })).toBe(9000);
    } finally {
      store.close();
    }
  });

  it('bootstraps all five substrate tables', () => {
    const store = new SqliteStore({ filePath: dbPath });
    try {
      const tables = store.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((row) => (row as { name: string }).name);
      expect(tables).toEqual(
        expect.arrayContaining([
          'last_pack',
          'meta',
          'ops_ledger',
          'reflection_queue',
          'reinforcement_queue',
        ]),
      );
    } finally {
      store.close();
    }
  });

  it('re-opening the same file is idempotent: no errors, schema unchanged, data preserved', () => {
    const first = new SqliteStore({ filePath: dbPath });
    first.db.prepare("INSERT INTO meta (key, value) VALUES ('probe', 'one')").run();
    first.close();

    const second = new SqliteStore({ filePath: dbPath });
    try {
      const row = second.db.prepare('SELECT value FROM meta WHERE key = ?').get('probe') as
        | { value: string }
        | undefined;
      expect(row?.value).toBe('one');

      const tableCount = second.db
        .prepare("SELECT COUNT(*) as c FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
        .get() as { c: number };
      expect(tableCount.c).toBe(1);
    } finally {
      second.close();
    }
  });
});
