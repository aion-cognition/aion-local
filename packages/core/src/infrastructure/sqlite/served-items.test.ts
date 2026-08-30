import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteStore } from './database.js';
import {
  deleteServedItems,
  purgeServedItemsIdleSince,
  readServedItems,
  recordServedItems,
} from './served-items.js';

const SESSION = 'session-a';
const OTHER = 'session-b';
const FIRST_AT = '2026-08-30T10:00:00.000Z';
const LATER_AT = '2026-08-30T11:00:00.000Z';

describe('the served-item record', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-served-items-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function firstServedAt(sessionId: string, itemId: string): string | undefined {
    const row = store.db
      .prepare('SELECT first_served_at FROM served_items WHERE session_id = ? AND item_id = ?')
      .get(sessionId, itemId) as { first_served_at: string } | undefined;
    return row?.first_served_at;
  }

  it('answers with nothing for a session that has been served nothing', () => {
    expect(readServedItems(store.db, SESSION).size).toBe(0);
  });

  it('reads back every item it recorded, by node id', () => {
    recordServedItems(
      store.db,
      SESSION,
      [
        { itemId: 'e1', fingerprint: 'hash-1' },
        { itemId: 'e2', fingerprint: 'hash-2' },
      ],
      FIRST_AT,
    );

    expect([...readServedItems(store.db, SESSION)]).toEqual([
      ['e1', 'hash-1'],
      ['e2', 'hash-2'],
    ]);
  });

  it('keeps one session out of another session record', () => {
    recordServedItems(store.db, SESSION, [{ itemId: 'e1', fingerprint: 'hash-1' }], FIRST_AT);

    expect(readServedItems(store.db, OTHER).size).toBe(0);
  });

  it('holds one row per item however often the item is served again', () => {
    recordServedItems(store.db, SESSION, [{ itemId: 'e1', fingerprint: 'hash-1' }], FIRST_AT);
    recordServedItems(store.db, SESSION, [{ itemId: 'e1', fingerprint: 'hash-1' }], LATER_AT);

    expect(readServedItems(store.db, SESSION).size).toBe(1);
  });

  it('takes the new fingerprint when a changed memory is served again', () => {
    recordServedItems(store.db, SESSION, [{ itemId: 'e1', fingerprint: 'hash-1' }], FIRST_AT);
    recordServedItems(store.db, SESSION, [{ itemId: 'e1', fingerprint: 'hash-2' }], LATER_AT);

    expect(readServedItems(store.db, SESSION).get('e1')).toBe('hash-2');
  });

  /** The stamp is when the session learned the memory, which a re-serve does not change. */
  it('leaves the first-served stamp alone on a re-serve', () => {
    recordServedItems(store.db, SESSION, [{ itemId: 'e1', fingerprint: 'hash-1' }], FIRST_AT);
    recordServedItems(store.db, SESSION, [{ itemId: 'e1', fingerprint: 'hash-2' }], LATER_AT);

    expect(firstServedAt(SESSION, 'e1')).toBe(FIRST_AT);
  });

  it('writes nothing at all for a pack that served nothing', () => {
    recordServedItems(store.db, SESSION, [], FIRST_AT);

    expect(readServedItems(store.db, SESSION).size).toBe(0);
  });

  it('drops one session record on close and leaves every other session standing', () => {
    recordServedItems(store.db, SESSION, [{ itemId: 'e1', fingerprint: 'hash-1' }], FIRST_AT);
    recordServedItems(store.db, OTHER, [{ itemId: 'e1', fingerprint: 'hash-1' }], FIRST_AT);

    expect(deleteServedItems(store.db, SESSION)).toBe(1);
    expect(readServedItems(store.db, SESSION).size).toBe(0);
    expect(readServedItems(store.db, OTHER).size).toBe(1);
  });

  it('deletes nothing for a session that closed without ever being served', () => {
    expect(deleteServedItems(store.db, SESSION)).toBe(0);
  });
});

/**
 * The rows a close will never reach: a killed process, or a restart, empties the session map
 * while the record stays on disk. The purge is what bounds how long they can outlive it.
 */
describe('purging the sessions no close will name', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-served-items-purge-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('drops a session whose newest row is older than the cutoff', () => {
    recordServedItems(store.db, SESSION, [{ itemId: 'e1', fingerprint: 'hash-1' }], FIRST_AT);

    expect(purgeServedItemsIdleSince(store.db, LATER_AT)).toBe(1);
    expect(readServedItems(store.db, SESSION).size).toBe(0);
  });

  /**
   * The reason a session is judged on its newest row rather than row by row: one conversation
   * can be handed a memory in its first minute and still be running hours later, and losing
   * that row would serve the memory to it a second time.
   */
  it('keeps the early rows of a session that is still being served', () => {
    recordServedItems(store.db, SESSION, [{ itemId: 'e1', fingerprint: 'hash-1' }], FIRST_AT);
    recordServedItems(store.db, SESSION, [{ itemId: 'e2', fingerprint: 'hash-2' }], LATER_AT);

    expect(purgeServedItemsIdleSince(store.db, '2026-08-30T10:30:00.000Z')).toBe(0);
    expect(readServedItems(store.db, SESSION).size).toBe(2);
  });

  it('purges one idle session without touching a live one', () => {
    recordServedItems(store.db, SESSION, [{ itemId: 'e1', fingerprint: 'hash-1' }], FIRST_AT);
    recordServedItems(store.db, OTHER, [{ itemId: 'e1', fingerprint: 'hash-1' }], LATER_AT);

    expect(purgeServedItemsIdleSince(store.db, '2026-08-30T10:30:00.000Z')).toBe(1);
    expect(readServedItems(store.db, SESSION).size).toBe(0);
    expect(readServedItems(store.db, OTHER).size).toBe(1);
  });
});
