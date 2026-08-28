import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStore } from './database.js';
import { getMeta, setMeta } from './meta.js';

describe('meta accessors', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-meta-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns undefined for a missing key', () => {
    expect(getMeta(store.db, 'graph_schema_version')).toBeUndefined();
  });

  it('round-trips a set value', () => {
    setMeta(store.db, 'graph_schema_version', '1');
    expect(getMeta(store.db, 'graph_schema_version')).toBe('1');
  });

  it('overwrites on a second set for the same key', () => {
    setMeta(store.db, 'graph_schema_version', '1');
    setMeta(store.db, 'graph_schema_version', '2');
    expect(getMeta(store.db, 'graph_schema_version')).toBe('2');
  });
});
