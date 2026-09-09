import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteStore } from './database.js';
import {
  closeSourceIncidence,
  commitSourceIncidence,
  IncidenceRoleMismatch,
} from './source-incidence.js';

const NOW = '2026-09-08T02:00:00.000Z';

describe('source incidence', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-incidence-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function link(linkId: string, kind: string): void {
    store.db
      .prepare(
        `INSERT INTO evidence_links
           (link_id, kind, qualifier, from_id, to_id, record_source, created_at)
         VALUES (?, ?, 'retained_node', 'source-1', 'node-1', 'test', ?)`,
      )
      .run(linkId, kind, NOW);
  }

  function rowOf(role: string): { role: string; currency: string; link_version: number } {
    return store.db
      .prepare('SELECT role, currency, link_version FROM source_incidence WHERE role = ?')
      .get(role) as { role: string; currency: string; link_version: number };
  }

  it('records the role the link is classified under', () => {
    link('link-1', 'mention');

    commitSourceIncidence(store.db, {
      sourceId: 'source-1',
      nodeId: 'node-1',
      role: 'mention',
      linkId: 'link-1',
      linkVersion: 1,
      currency: 'open',
    });

    expect(rowOf('mention')).toMatchObject({ currency: 'open', link_version: 1 });
  });

  it('refuses a role the link does not carry', () => {
    link('link-1', 'mention');

    expect(() => {
      commitSourceIncidence(store.db, {
        sourceId: 'source-1',
        nodeId: 'node-1',
        role: 'extraction',
        linkId: 'link-1',
        linkVersion: 1,
        currency: 'open',
      });
    }).toThrow(IncidenceRoleMismatch);
    // A historical read whose projection row is gone answers the role from the link's kind, so
    // a row that disagreed with its link would answer that question with the wrong role.
    expect(rowOf('extraction')).toBeUndefined();
  });

  it('refuses an incidence with no link behind it', () => {
    expect(() => {
      commitSourceIncidence(store.db, {
        sourceId: 'source-1',
        nodeId: 'node-1',
        role: 'mention',
        linkId: 'missing',
        linkVersion: 1,
        currency: 'open',
      });
    }).toThrow(/no evidence link records/);
  });

  it('moves a repeated write forward instead of writing a second row', () => {
    link('link-1', 'mention');
    const row = {
      sourceId: 'source-1',
      nodeId: 'node-1',
      role: 'mention',
      linkId: 'link-1',
      currency: 'open' as const,
    };
    commitSourceIncidence(store.db, { ...row, linkVersion: 1 });
    commitSourceIncidence(store.db, { ...row, linkVersion: 2 });

    expect(store.db.prepare('SELECT count(*) AS n FROM source_incidence').get()).toEqual({ n: 1 });
    expect(rowOf('mention').link_version).toBe(2);
  });

  it('closes an incidence without removing the record that it existed', () => {
    link('link-1', 'mention');
    commitSourceIncidence(store.db, {
      sourceId: 'source-1',
      nodeId: 'node-1',
      role: 'mention',
      linkId: 'link-1',
      linkVersion: 1,
      currency: 'open',
    });

    expect(
      closeSourceIncidence(store.db, {
        sourceId: 'source-1',
        nodeId: 'node-1',
        role: 'mention',
      }),
    ).toBe(true);
    expect(rowOf('mention')).toMatchObject({ currency: 'closed' });
  });
});
