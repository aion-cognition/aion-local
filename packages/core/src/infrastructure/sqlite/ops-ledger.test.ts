import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStore } from './database.js';
import { getLedgerEntry, isLedgerApplied, markLedgerApplied } from './ops-ledger.js';

describe('ops ledger accessors', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-ledger-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const key = 'reflection:orchestrator:episode-1';

  it('is not applied until marked', () => {
    expect(isLedgerApplied(store.db, key)).toBe(false);
    expect(getLedgerEntry(store.db, key)).toBeUndefined();
  });

  it('marks a key applied with a summary and reads it back', () => {
    markLedgerApplied(store.db, key, { entities: 3, associations: 5 });
    expect(isLedgerApplied(store.db, key)).toBe(true);

    const entry = getLedgerEntry(store.db, key);
    expect(entry?.key).toBe(key);
    expect(entry?.summary).toEqual({ entities: 3, associations: 5 });
    expect(typeof entry?.appliedAt).toBe('string');
  });

  it('marks a key applied with no summary', () => {
    markLedgerApplied(store.db, key);
    expect(getLedgerEntry(store.db, key)?.summary).toBeUndefined();
  });

  it('re-marking the same key is idempotent: one row, latest summary wins', () => {
    markLedgerApplied(store.db, key, { entities: 1 });
    markLedgerApplied(store.db, key, { entities: 2 });

    const count = store.db
      .prepare('SELECT COUNT(*) as c FROM ops_ledger WHERE key = ?')
      .get(key) as { c: number };
    expect(count.c).toBe(1);
    expect(getLedgerEntry(store.db, key)?.summary).toEqual({ entities: 2 });
  });
});
