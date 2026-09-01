import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteStore } from './database.js';
import {
  ARCHIVE_SCHEMA_VERSION,
  countExperiencesByVersion,
  experienceArchiveKey,
  getExperienceByEpisode,
  insertExperience,
  listExperiencesAfter,
  type ExperienceArchiveCursor,
  type ExperienceArchiveInput,
} from './experience-archive.js';

function input(overrides: Partial<ExperienceArchiveInput> = {}): ExperienceArchiveInput {
  return {
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    pipelineVersion: 'v1',
    identity: 'agent-desktop-1',
    sessionId: 'session-1',
    episodeId: 'episode-1',
    contentHash: 'content-hash-1',
    occurredAt: '2026-01-01T00:00:00.000Z',
    archivedAt: '2026-01-01T00:05:00.000Z',
    lane: 'interactive',
    origin: { channel: 'hook', event: 'PostToolUse' },
    payload: { summary: 'debugged the WAL retry loop', turns: [{ role: 'user', text: 'hi' }] },
    ...overrides,
  };
}

describe('experience archive storage', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-experience-archive-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the table with exactly the columns the schema declares', () => {
    const columns = (store.db.pragma('table_info(experience_archive)') as { name: string }[]).map(
      (column) => column.name,
    );

    expect(columns).toEqual([
      'id',
      'idempotency_key',
      'schema_version',
      'pipeline_version',
      'identity',
      'session_id',
      'episode_id',
      'content_hash',
      'occurred_at',
      'archived_at',
      'lane',
      'origin_json',
      'payload_json',
    ]);
  });

  it('round-trips every column through insert and read', () => {
    const row = input();

    expect(insertExperience(store.db, row)).toBe(true);

    expect(getExperienceByEpisode(store.db, 'episode-1')).toEqual({
      id: expect.any(String),
      idempotencyKey: experienceArchiveKey(row.identity, row.contentHash, row.schemaVersion),
      ...row,
    });
  });

  it('archives a payload with no lane and no origin as absent, not null strings', () => {
    const row = input({ lane: undefined, origin: undefined });

    insertExperience(store.db, row);

    const stored = getExperienceByEpisode(store.db, row.episodeId);
    expect(stored?.lane).toBeUndefined();
    expect(stored?.origin).toBeUndefined();
  });

  it('reads back an absent episode as undefined rather than throwing', () => {
    expect(getExperienceByEpisode(store.db, 'no-such-episode')).toBeUndefined();
  });

  it('does not rewrite the first row when the same idempotency key is inserted again', () => {
    const first = input();
    expect(insertExperience(store.db, first)).toBe(true);

    // Same identity, content hash and schema version fold to the same key even though the
    // episode and session differ, which is the shape a re-pushed payload actually takes.
    const repeat = input({
      episodeId: 'episode-2',
      sessionId: 'session-2',
      archivedAt: '2026-01-01T01:00:00.000Z',
    });
    expect(insertExperience(store.db, repeat)).toBe(false);

    expect(getExperienceByEpisode(store.db, 'episode-2')).toBeUndefined();
    const stored = getExperienceByEpisode(store.db, 'episode-1');
    expect(stored?.sessionId).toBe('session-1');
    expect(stored?.archivedAt).toBe('2026-01-01T00:05:00.000Z');
    expect(listExperiencesAfter(store.db, undefined, 10)).toHaveLength(1);
  });

  it('archives the same content under two identities as two separate rows', () => {
    const first = input({ identity: 'identity-a', episodeId: 'episode-a' });
    const second = input({ identity: 'identity-b', episodeId: 'episode-b' });

    expect(insertExperience(store.db, first)).toBe(true);
    expect(insertExperience(store.db, second)).toBe(true);
    expect(listExperiencesAfter(store.db, undefined, 10)).toHaveLength(2);
  });

  it('paginates by keyset over (occurred_at, id), oldest first, with no gap and no repeat', () => {
    const rows = Array.from({ length: 9 }, (_, index) =>
      input({
        episodeId: `episode-${index}`,
        identity: `identity-${index}`,
        contentHash: `hash-${index}`,
        occurredAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
      }),
    );
    // Inserted newest first, so a pass ordered by insertion rather than by occurred_at would
    // fail this test.
    for (const row of [...rows].reverse()) {
      insertExperience(store.db, row);
    }

    const seen: string[] = [];
    let cursor: ExperienceArchiveCursor | undefined;
    for (let page = 0; page < 3; page += 1) {
      const batch = listExperiencesAfter(store.db, cursor, 3);
      expect(batch).toHaveLength(3);
      seen.push(...batch.map((row) => row.episodeId));
      const last = batch[batch.length - 1];
      if (last === undefined) {
        throw new Error('a three-row batch has a last row');
      }
      cursor = { occurredAt: last.occurredAt, id: last.id };
    }

    expect(seen).toEqual(rows.map((row) => row.episodeId));
    expect(new Set(seen).size).toBe(9);
    expect(listExperiencesAfter(store.db, cursor, 3)).toEqual([]);
  });

  it('excludes a pipeline version from a page when the filter names it', () => {
    insertExperience(store.db, input({ episodeId: 'ep-v1', pipelineVersion: 'v1' }));
    insertExperience(
      store.db,
      input({ episodeId: 'ep-v2', identity: 'identity-v2', pipelineVersion: 'v2' }),
    );

    const stale = listExperiencesAfter(store.db, undefined, 10, { excludePipelineVersion: 'v2' });
    expect(stale.map((row) => row.episodeId)).toEqual(['ep-v1']);
  });

  it('counts rows by pipeline version', () => {
    insertExperience(store.db, input({ episodeId: 'ep-1', pipelineVersion: 'v1' }));
    insertExperience(
      store.db,
      input({ episodeId: 'ep-2', identity: 'identity-2', pipelineVersion: 'v1' }),
    );
    insertExperience(
      store.db,
      input({ episodeId: 'ep-3', identity: 'identity-3', pipelineVersion: 'v2' }),
    );

    expect(countExperiencesByVersion(store.db)).toEqual([
      { version: 'v1', count: 2 },
      { version: 'v2', count: 1 },
    ]);
  });
});

describe('experience archive across sqlite opens', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-experience-archive-reopen-'));
    dbPath = join(dir, 'aion.sqlite');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a fresh file and a file opened twice converge on the same table shape and keep its rows', () => {
    const first = new SqliteStore({ filePath: dbPath });
    insertExperience(first.db, input());
    first.close();

    const second = new SqliteStore({ filePath: dbPath });
    try {
      const columns = (
        second.db.pragma('table_info(experience_archive)') as { name: string }[]
      ).map((column) => column.name);
      expect(columns).toEqual([
        'id',
        'idempotency_key',
        'schema_version',
        'pipeline_version',
        'identity',
        'session_id',
        'episode_id',
        'content_hash',
        'occurred_at',
        'archived_at',
        'lane',
        'origin_json',
        'payload_json',
      ]);
      expect(getExperienceByEpisode(second.db, 'episode-1')?.sessionId).toBe('session-1');
    } finally {
      second.close();
    }

    const third = new SqliteStore({ filePath: dbPath });
    third.close();
  });
});
