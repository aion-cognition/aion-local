import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_BUSY_TIMEOUT_MS, SqliteStore } from './database.js';

describe('SqliteStore', () => {
  let dir: string;
  let dbPath: string;

  /** The store creates the nested directory itself; a raw connection has to be given one. */
  function dbPathWithDirectory(): string {
    mkdirSync(dirname(dbPath), { recursive: true });
    return dbPath;
  }

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

  /**
   * The live substrate was written before the queue had lanes, so the columns arrive by
   * ALTER on the next open with rows already in the table. SQLite has no `ADD COLUMN IF NOT
   * EXISTS`, and a second ALTER raises "duplicate column name" and takes the whole open with
   * it, so the third open below is the assertion that matters.
   */
  it('retrofits the lane columns onto a queue table that predates them, keeping its rows', () => {
    const legacy = new Database(dbPathWithDirectory());
    legacy.exec(`CREATE TABLE reflection_queue (
      id TEXT PRIMARY KEY,
      job_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      enqueued_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      claimed_at TEXT,
      claimed_by TEXT,
      last_error TEXT
    )`);
    legacy
      .prepare(
        `INSERT INTO reflection_queue (id, job_type, payload_json, enqueued_at)
         VALUES ('job-1', 'integrate', '{"episode_id":"ep-1"}', '2026-08-01T00:00:00.000Z')`,
      )
      .run();
    legacy.close();

    const store = new SqliteStore({ filePath: dbPath });
    try {
      const row = store.db.prepare('SELECT * FROM reflection_queue WHERE id = ?').get('job-1') as {
        lane: string;
        session_id: string | null;
        lane_seq: number;
      };
      expect(row).toMatchObject({ lane: 'interactive', session_id: null, lane_seq: 0 });
    } finally {
      store.close();
    }

    const reopened = new SqliteStore({ filePath: dbPath });
    reopened.close();
  });

  it('re-opening the same file is idempotent: no errors, schema unchanged, data preserved', () => {
    const first = new SqliteStore({ filePath: dbPath });
    first.db.prepare("INSERT INTO meta (key, value) VALUES ('probe', 'one')").run();
    first.close();

    const second = new SqliteStore({ filePath: dbPath });
    try {
      const row = second.db.prepare('SELECT value FROM meta WHERE key = ?').get('probe') as
        { value: string } | undefined;
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
