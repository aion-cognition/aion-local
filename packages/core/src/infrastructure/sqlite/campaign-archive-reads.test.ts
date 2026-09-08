import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  readApiCallCensus,
  readArchiveCensus,
  readArchiveShapePage,
  readUsageEventCensus,
} from './campaign-archive-reads.js';
import { SqliteStore, openReadOnlySqliteHandle, sqliteTableExists } from './database.js';
import {
  ARCHIVE_SCHEMA_VERSION,
  insertExperience,
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
    payload: { turns: [{ role: 'user', text: 'hi' }] },
    ...overrides,
  };
}

describe('measuring the stored archive', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-campaign-archive-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('counts the parts each record carries', () => {
    insertExperience(
      store.db,
      input({
        payload: {
          turns: [
            { role: 'user', text: 'a' },
            { role: 'assistant', text: 'b' },
          ],
          observations: ['one'],
          tool_executions: [{ tool: 'bash', status: 'ok' }],
        },
      }),
    );

    const [shape] = readArchiveShapePage(store.db, undefined, 10);
    expect(shape).toMatchObject({
      episodeId: 'episode-1',
      turnCount: 2,
      observationCount: 1,
      toolExecutionCount: 1,
    });
  });

  it('reads the stored bytes rather than the bytes a re-serialization would produce', () => {
    insertExperience(store.db, input({ payload: { observations: ['ééé'] } }));
    const [shape] = readArchiveShapePage(store.db, undefined, 10);
    const stored = store.db
      .prepare('SELECT payload_json AS json FROM experience_archive')
      .get() as { json: string };
    expect(shape?.payloadBytes).toBe(Buffer.byteLength(stored.json, 'utf8'));
    expect(shape?.payloadBytes).toBeGreaterThan(stored.json.length);
  });

  it('pages oldest first and resumes from the last row of the previous page', () => {
    for (const index of [0, 1, 2]) {
      insertExperience(
        store.db,
        input({
          episodeId: `episode-${String(index)}`,
          contentHash: `hash-${String(index)}`,
          occurredAt: `2026-01-0${String(index + 1)}T00:00:00.000Z`,
        }),
      );
    }

    const first = readArchiveShapePage(store.db, undefined, 2);
    expect(first.map((row) => row.episodeId)).toEqual(['episode-0', 'episode-1']);

    const last = first[first.length - 1];
    const second = readArchiveShapePage(
      store.db,
      last === undefined ? undefined : { occurredAt: last.occurredAt, id: last.id },
      2,
    );
    expect(second.map((row) => row.episodeId)).toEqual(['episode-2']);
  });

  it('counts rows, episodes, sessions and identities apart from each other', () => {
    insertExperience(store.db, input());
    insertExperience(
      store.db,
      input({ episodeId: 'episode-2', contentHash: 'hash-2', sessionId: 'session-2' }),
    );
    expect(readArchiveCensus(store.db)).toEqual({
      rows: 2,
      episodes: 2,
      sessions: 2,
      identities: 1,
    });
  });

  it('reports empty meters as zero rows with no bounds', () => {
    expect(readUsageEventCensus(store.db)).toEqual({ rows: 0 });
    expect(readApiCallCensus(store.db)).toEqual({ rows: 0, usageErrors: 0 });
  });
});

describe('opening a substrate to measure it', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-campaign-readonly-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a path that holds no substrate instead of creating one', () => {
    const missing = join(dir, 'absent.sqlite');
    expect(() => openReadOnlySqliteHandle({ filePath: missing })).toThrow();
    expect(() => openReadOnlySqliteHandle({ filePath: missing })).toThrow();
  });

  it('cannot write to the substrate it opened', () => {
    const path = join(dir, 'aion.sqlite');
    const store = new SqliteStore({ filePath: path });
    insertExperience(store.db, input());
    store.close();

    const reader = openReadOnlySqliteHandle({ filePath: path });
    try {
      expect(sqliteTableExists(reader, 'experience_archive')).toBe(true);
      expect(readArchiveCensus(reader).rows).toBe(1);
      expect(() => reader.prepare('DELETE FROM experience_archive').run()).toThrow();
    } finally {
      reader.close();
    }
  });

  it('reports a table the substrate does not hold', () => {
    const path = join(dir, 'aion.sqlite');
    const store = new SqliteStore({ filePath: path });
    store.close();
    const reader = openReadOnlySqliteHandle({ filePath: path });
    try {
      expect(sqliteTableExists(reader, 'source_records')).toBe(false);
    } finally {
      reader.close();
    }
  });
});
