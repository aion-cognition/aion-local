import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

import { SqliteStore } from './database.js';

it('refuses a file that did not enter WAL before migration and closes the rejected handle', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aion-wal-required-'));
  const filePath = join(dir, 'store.sqlite');
  const original = Database.prototype.pragma;
  const observed: Database.Database[] = [];
  let opened: SqliteStore | undefined;
  let caught: unknown;
  const probe = vi.spyOn(Database.prototype, 'pragma').mockImplementation(function (
    this: Database.Database,
    statement,
    options,
  ) {
    if (statement === 'journal_mode = WAL') {
      observed.push(this);
      // Simulate a native refusal with a real non-WAL mode, rather than a fabricated value.
      return original.call(this, 'journal_mode = DELETE', options);
    }
    return original.call(this, statement, options);
  });
  try {
    try {
      opened = new SqliteStore({ filePath });
    } catch (error) {
      caught = error;
    }
    expect.soft(caught).toBeInstanceOf(Error);
    expect.soft(caught).toMatchObject({ message: expect.stringContaining('WAL') });
    expect.soft(observed).toHaveLength(1);
    expect.soft(observed[0]?.open).toBe(false);
    const inspection = new Database(filePath, { readonly: true, fileMustExist: true });
    try {
      expect(inspection.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual(
        [],
      );
    } finally {
      inspection.close();
    }
  } finally {
    opened?.close();
    probe.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('keeps explicit in-memory stores usable without pretending their journal is WAL', () => {
  const store = new SqliteStore({ filePath: ':memory:' });
  try {
    expect(store.db.pragma('journal_mode', { simple: true })).toBe('memory');
    expect(
      store.db.prepare("SELECT name FROM sqlite_master WHERE name='ops_ledger'").get(),
    ).toEqual({ name: 'ops_ledger' });
  } finally {
    store.close();
  }
});
