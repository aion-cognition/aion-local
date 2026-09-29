import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  locateArchiveParts,
  readArchivedIdentity,
  readArchivePart,
  type ArchivePartKind,
} from './archive-parts.js';
import { openSqliteHandle, type SqliteHandle } from './database.js';
import { readSourceRecord } from './source-identity.js';
import { seedSource } from '../../evidence/test-support/evidence.fixture.js';
import type { ReflectionContent } from '../../reflection/domain/content.js';

const NOW = new Date('2026-09-20T12:00:00.000Z');

let dir: string;
let db: SqliteHandle;

function archive(content: ReflectionContent): string {
  seedSource(db, { sourceId: 'episode', sessionId: 's', identity: 'i', content, now: NOW });
  const archiveId = readSourceRecord(db, 'episode')?.canonicalArchiveId;
  if (archiveId == null) {
    throw new Error('fixture did not archive');
  }
  return archiveId;
}

const CONTENT: ReflectionContent = {
  turns: [
    { role: 'user', text: 'what is the plan for today?' },
    { role: 'assistant', text: 'Aion Local ships first. ŁÓDŹ is where the meetup is.' },
    { role: 'user', text: 'and Aion Cognition with it' },
  ],
  tool_executions: [
    {
      tool: 'Read',
      status: 'ok',
      input: { path: '/repo' },
      output: 'Aion Local\nand Aion Cognition',
    },
  ],
  observations: ['nothing about either'],
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-archive-parts-'));
  db = openSqliteHandle({ filePath: join(dir, 'aion.sqlite') });
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('locateArchiveParts', () => {
  it('finds the first part naming each set, and the first naming both', () => {
    const archiveId = archive(CONTENT);

    const location = locateArchiveParts(
      db,
      archiveId,
      [['Aion Local'], ['Aion Cognition']],
      10_000,
    );

    expect(location.first[0]).toMatchObject({ partKind: 'turn', ordinal: 1 });
    expect(location.first[1]).toMatchObject({ partKind: 'turn', ordinal: 2 });
    expect(location.together).toMatchObject({ partKind: 'tool_execution', ordinal: 0 });
    expect(location.opening).toMatchObject({ partKind: 'turn', ordinal: 0 });
    expect(location.oversized).toEqual([0, 0]);
  });

  it('matches ASCII case on its own and other scripts through the variants it is given', () => {
    const archiveId = archive(CONTENT);

    const ascii = locateArchiveParts(db, archiveId, [['aion local'], []], 10_000);
    const bare = locateArchiveParts(db, archiveId, [['łódź'], []], 10_000);
    const varied = locateArchiveParts(db, archiveId, [['łódź', 'ŁÓDŹ'], []], 10_000);

    expect(ascii.first[0]).toMatchObject({ partKind: 'turn', ordinal: 1 });
    expect(bare.first[0]).toBeUndefined();
    expect(varied.first[0]).toMatchObject({ partKind: 'turn', ordinal: 1 });
  });

  it('sizes each part as the UTF-8 length of the JSON text a part read returns', () => {
    const archiveId = archive(CONTENT);
    const location = locateArchiveParts(
      db,
      archiveId,
      [['Aion Local'], ['Aion Cognition']],
      10_000,
    );

    for (const part of [location.first[0], location.first[1], location.together]) {
      const json = readArchivePart(db, archiveId, part!);
      expect(part?.storedBytes).toBe(Buffer.byteLength(json!, 'utf8'));
    }
  });

  it('counts a naming part over the size bound and does not offer it', () => {
    const archiveId = archive({
      turns: [
        { role: 'assistant', text: `Aion Local ${'x'.repeat(4000)}` },
        { role: 'user', text: 'no names here' },
      ],
      tool_executions: [{ tool: 'Grep', status: 'ok', output: 'Aion Local once more' }],
    });

    const location = locateArchiveParts(db, archiveId, [['Aion Local'], []], 1_000);

    expect(location.oversized).toEqual([1, 0]);
    expect(location.first[0]).toMatchObject({ partKind: 'tool_execution', ordinal: 0 });
    expect(location.opening).toMatchObject({ partKind: 'turn', ordinal: 1 });
  });

  it('refuses a payload that is not JSON rather than locating in it', () => {
    const archiveId = archive(CONTENT);
    db.prepare('UPDATE experience_archive SET payload_json = ? WHERE id = ?').run(
      '{not',
      archiveId,
    );

    expect(() => locateArchiveParts(db, archiveId, [['Aion Local'], []], 10_000)).toThrow();
  });
});

describe('readArchivePart', () => {
  it('returns exactly the one part asked for', () => {
    const archiveId = archive(CONTENT);
    const read = (partKind: ArchivePartKind, ordinal: number): unknown => {
      const json = readArchivePart(db, archiveId, { partKind, ordinal });
      return json === undefined ? undefined : JSON.parse(json);
    };

    expect(read('turn', 1)).toEqual(CONTENT.turns?.[1]);
    expect(read('tool_execution', 0)).toEqual(CONTENT.tool_executions?.[0]);
    expect(read('observation', 0)).toBe('nothing about either');
    expect(read('turn', 9)).toBeUndefined();
    expect(read('turn', -1)).toBeUndefined();
  });
});

describe('readArchivedIdentity', () => {
  it('reads the proof columns without selecting the payload', () => {
    const archiveId = archive(CONTENT);
    const prepare = vi.spyOn(db, 'prepare');

    const identity = readArchivedIdentity(db, archiveId);

    expect(identity).toMatchObject({ id: archiveId, identity: 'i', schemaVersion: 1 });
    expect(prepare.mock.calls.map(([sql]) => sql).join('\n')).not.toContain('payload_json');
  });
});
