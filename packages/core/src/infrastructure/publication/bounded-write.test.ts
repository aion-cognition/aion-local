import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PublicationInvariantError, PublicationRetryableError } from './errors.js';
import { SqliteStore } from '../sqlite/database.js';
import { publicationWrite } from '../sqlite/publication-bounded.js';
import { preparePublicationIntent } from '../sqlite/publication-intents.js';

const NOW = new Date('2026-09-08T02:00:00.000Z');

function busy(db: { pragma(s: string, o?: unknown): unknown }): number {
  return db.pragma('busy_timeout', { simple: true }) as number;
}

describe('publication transaction boundaries', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'a1-probe-'));
    store = new SqliteStore({ filePath: join(dir, 'probe.sqlite') });
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a promise-returning effect and rolls its writes back', () => {
    const { db } = store;
    let thrown: unknown;
    try {
      publicationWrite(db, () => {
        db.prepare("INSERT INTO ops_ledger (key, applied_at) VALUES ('probe-async', ?)").run(
          NOW.toISOString(),
        );
        return Promise.resolve(1) as unknown as number;
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(PublicationInvariantError);
    expect((thrown as PublicationInvariantError).reason).toBe('async_sqlite_effect');
    expect(db.prepare("SELECT 1 FROM ops_ledger WHERE key = 'probe-async'").get()).toBeUndefined();
  });

  it('refuses entry from an enclosing SQLite transaction', () => {
    const { db } = store;
    expect(() => db.transaction(() => publicationWrite(db, () => 1)).immediate()).toThrow(
      /enclosing_sqlite_transaction/,
    );
  });

  it('restores busy_timeout on success, on throw and on async refusal', () => {
    const { db } = store;
    const before = busy(db);
    expect(before).toBe(5000);
    expect(publicationWrite(db, () => busy(db))).toBe(0);
    expect(busy(db)).toBe(before);
    expect(() =>
      publicationWrite(db, () => {
        throw new Error('domain failure');
      }),
    ).toThrow('publication_failed');
    expect(busy(db)).toBe(before);
    expect(() => publicationWrite(db, () => Promise.resolve(1) as unknown as number)).toThrow();
    expect(busy(db)).toBe(before);
  });

  it('a writer conflict retains its native diagnostic and restores the timeout', () => {
    const { db } = store;
    const other = new Database(join(dir, 'probe.sqlite'));
    other.pragma('busy_timeout = 5000');
    try {
      other.exec('BEGIN IMMEDIATE');
      other
        .prepare("INSERT INTO ops_ledger (key, applied_at) VALUES ('holder', ?)")
        .run(NOW.toISOString());
      let thrown: unknown;
      const started = Date.now();
      try {
        publicationWrite(db, () => 1);
      } catch (err) {
        thrown = err;
      }
      const elapsed = Date.now() - started;
      expect(thrown).toBeInstanceOf(PublicationRetryableError);
      expect(thrown).toMatchObject({ reason: 'store_busy', cause: { code: 'SQLITE_BUSY' } });
      // Contention is retryable; a protocol invariant is not.
      expect(thrown).not.toBeInstanceOf(PublicationInvariantError);
      expect(elapsed).toBeLessThan(500);
      expect(busy(db)).toBe(5000);
    } finally {
      other.exec('ROLLBACK');
      other.close();
    }
  });

  it('nested immediate transactions run as savepoints and roll back with the outer', () => {
    const { db } = store;
    let innerSequence = '';
    expect(() =>
      publicationWrite(db, () => {
        innerSequence = preparePublicationIntent(db, {
          operationId: 'probe-nested',
          kind: 'intake',
          payloadDigest: 'd',
          payloadJson: '{}',
          affectedScopesJson: '[]',
          expectedJson: '{}',
          preparedActionsJson: '{"data":{},"effects":[]}',
          createdAt: NOW,
        });
        expect(BigInt(innerSequence)).toBeGreaterThan(0n);
        expect(
          db.prepare("SELECT 1 FROM publication_intents WHERE operation_id = 'probe-nested'").get(),
        ).toBeDefined();
        throw new Error('outer failure after nested commit');
      }),
    ).toThrow('publication_failed');
    expect(
      db.prepare("SELECT 1 FROM publication_intents WHERE operation_id = 'probe-nested'").get(),
    ).toBeUndefined();
    expect(db.inTransaction).toBe(false);
  });
});
