import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStore } from './database.js';
import { getLastPack, saveLastPack } from './last-pack.js';

describe('last pack accessors', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-lastpack-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns undefined for a session with no saved pack', () => {
    expect(getLastPack(store.db, 'session-1')).toBeUndefined();
  });

  it('round-trips a saved pack', () => {
    saveLastPack(store.db, 'session-1', { facts: [], episodes: [{ id: 'ep-1' }] });
    const saved = getLastPack(store.db, 'session-1');

    expect(saved?.sessionId).toBe('session-1');
    expect(saved?.pack).toEqual({ facts: [], episodes: [{ id: 'ep-1' }] });
  });

  it('a second save for the same session replaces, not appends', () => {
    saveLastPack(store.db, 'session-1', { episodes: [{ id: 'ep-1' }] }, '2026-01-01T00:00:00.000Z');
    saveLastPack(store.db, 'session-1', { episodes: [{ id: 'ep-2' }] }, '2026-01-02T00:00:00.000Z');

    const count = store.db
      .prepare('SELECT COUNT(*) as c FROM last_pack WHERE session_id = ?')
      .get('session-1') as { c: number };
    expect(count.c).toBe(1);

    const saved = getLastPack(store.db, 'session-1');
    expect(saved?.pack).toEqual({ episodes: [{ id: 'ep-2' }] });
    expect(saved?.ts).toBe('2026-01-02T00:00:00.000Z');
  });

  it('keeps separate rows per session', () => {
    saveLastPack(store.db, 'session-1', { n: 1 });
    saveLastPack(store.db, 'session-2', { n: 2 });

    expect(getLastPack(store.db, 'session-1')?.pack).toEqual({ n: 1 });
    expect(getLastPack(store.db, 'session-2')?.pack).toEqual({ n: 2 });
  });
});
