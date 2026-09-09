import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteStore, sqliteTableExists } from './database.js';
import { withCorruptFts5, withoutFts5 } from './fts-capability.fixture.js';
import {
  ensureSearchProjection,
  probeFts5Capability,
  searchProjectionExists,
} from './fts-capability.js';
import { getMeta } from './meta.js';
import { SOURCE_SEARCH_FTS_TABLE } from './source-search-schema.js';

describe('full-text capability', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-fts-capability-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('opens the ordinary search tables without creating the virtual one', () => {
    expect(sqliteTableExists(store.db, 'source_search_documents')).toBe(true);
    expect(sqliteTableExists(store.db, 'source_search_progress')).toBe(true);
    expect(searchProjectionExists(store.db)).toBe(false);
  });

  it('proves the installed module on a disposable schema and leaves no table behind', () => {
    expect(probeFts5Capability(store.db)).toEqual({ status: 'available' });
    const temp = store.db
      .prepare("SELECT count(*) AS n FROM temp.sqlite_master WHERE type = 'table'")
      .get() as { n: number };
    expect(temp.n).toBe(0);
    expect(searchProjectionExists(store.db)).toBe(false);
  });

  it('unwinds its own savepoint and leaves surrounding work intact', () => {
    // Reversible by construction: the capability is proved by an executed create and undone by
    // rolling back to the savepoint, so nothing has to be deleted afterwards and a probe run
    // inside somebody else's transaction cannot take their work down with it.
    const written = store.db.transaction((): number => {
      store.db.prepare("INSERT INTO meta (key, value) VALUES ('probe-witness', '1')").run();
      expect(probeFts5Capability(store.db)).toEqual({ status: 'available' });
      const row = store.db
        .prepare("SELECT count(*) AS n FROM meta WHERE key = 'probe-witness'")
        .get() as {
        n: number;
      };
      return row.n;
    })();

    expect(written).toBe(1);
    expect(getMeta(store.db, 'probe-witness')).toBe('1');
    expect(searchProjectionExists(store.db)).toBe(false);
  });

  it('creates the projection once the capability is proved', () => {
    expect(ensureSearchProjection(store.db)).toEqual({ status: 'available' });
    expect(searchProjectionExists(store.db)).toBe(true);
    expect(ensureSearchProjection(store.db)).toEqual({ status: 'available' });
  });

  it('names a missing module as the capability it is', () => {
    const capability = probeFts5Capability(withoutFts5(store.db));
    expect(capability.status).toBe('unavailable');
    expect(capability).toMatchObject({ cause: 'fts5_unavailable' });
  });

  it('keeps a damaged store distinct from a missing module', () => {
    const capability = probeFts5Capability(withCorruptFts5(store.db));
    expect(capability.status).toBe('error');
    expect(capability).toMatchObject({ cause: 'search_store_error' });
    if (capability.status !== 'available') {
      expect(capability.detail).toContain('malformed');
    }
  });

  it('creates nothing when the capability is missing or broken', () => {
    expect(ensureSearchProjection(withoutFts5(store.db)).status).toBe('unavailable');
    expect(searchProjectionExists(store.db)).toBe(false);
    expect(ensureSearchProjection(withCorruptFts5(store.db)).status).toBe('error');
    expect(sqliteTableExists(store.db, SOURCE_SEARCH_FTS_TABLE)).toBe(false);
  });

  it('leaves intake and every other table usable when search is unavailable', () => {
    const handle = withoutFts5(store.db);
    expect(ensureSearchProjection(handle).status).toBe('unavailable');
    handle
      .prepare(
        `INSERT INTO source_search_documents
           (source_id, part_kind, part_ordinal, content_digest, index_policy_version,
            truncated, indexed_bytes)
         VALUES ('src', 'turn', 0, 'digest', 1, 0, 4)`,
      )
      .run();
    const row = handle.prepare('SELECT count(*) AS n FROM source_search_documents').get() as {
      n: number;
    };
    expect(row.n).toBe(1);
  });
});
