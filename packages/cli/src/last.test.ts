import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveLastPack, SqliteStore } from '@aion/core';
import type { MemoryPack } from '@aion/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MissingOptionValueError,
  parseLastFlags,
  renderPack,
  renderSessionList,
  runLast,
  UnknownOptionError,
} from './last.js';

function collector(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

const FIXTURE_PACK: MemoryPack = {
  episodes: [
    {
      id: 'ep-1',
      content: 'we picked webhooks for ingestion because polling was too slow',
      occurred_at: '2026-06-01T11:00:00.000Z',
      rank: 1,
      confidence: 0.834,
      rationale: { method: 'vector', score: 0.834 },
      currency: 'current',
    },
    {
      id: 'ep-2',
      content: 'standup moved to nine thirty on tuesdays',
      rank: 3,
      confidence: 0,
      rationale: {
        method: 'activation',
        score: 0.412,
        path: 'session-1 -[PARTICIPATES_IN]-> ep-2',
      },
      currency: 'superseded',
      superseded_by: { id: 'ep-3', at: '2026-06-02T09:00:00.000Z' },
    },
  ],
  facts: [
    {
      id: 'fact-1',
      content: 'prefers async standups',
      rank: 2,
      confidence: 0.62,
      rationale: { method: 'bm25', score: 0.62 },
      currency: 'current',
    },
  ],
  rendered_text: '# Memory\n\n## Episodes\n1. ...',
  metadata: {
    token_estimate: 128,
    stage_timings_ms: { cues: 120.4, embed: 15.2, seeds: 8.1, activation: 3, fusion: 42.55 },
    cues: [
      { text: 'webhooks ingestion', source: 'query', weight: 3 },
      { text: 'standup', source: 'summary', weight: 2 },
    ],
  },
};

const EMPTY_PACK: MemoryPack = {
  rendered_text: '# Memory\n\nNo memories matched this query.',
  metadata: {
    token_estimate: 6,
    stage_timings_ms: { cues: 0, embed: 0, seeds: 0, activation: 0, fusion: 0 },
    cues: [],
    degraded: [
      { stage: 'cues', reason: 'timeout' },
      { stage: 'graph', reason: 'unavailable' },
    ],
  },
};

describe('parseLastFlags', () => {
  it('defaults to no session filter and text output', () => {
    expect(parseLastFlags([])).toEqual({ json: false });
  });

  it('reads --json', () => {
    expect(parseLastFlags(['--json'])).toEqual({ json: true });
  });

  it('reads --session with its value', () => {
    expect(parseLastFlags(['--session', 'sess-1'])).toEqual({ session: 'sess-1', json: false });
  });

  it('combines --session and --json in either order', () => {
    expect(parseLastFlags(['--session', 'sess-1', '--json'])).toEqual({ session: 'sess-1', json: true });
    expect(parseLastFlags(['--json', '--session', 'sess-1'])).toEqual({ session: 'sess-1', json: true });
  });

  it('rejects --session with no value', () => {
    expect(() => parseLastFlags(['--session'])).toThrow(MissingOptionValueError);
  });

  it('rejects an unknown option', () => {
    expect(() => parseLastFlags(['--bogus'])).toThrow(UnknownOptionError);
  });
});

describe('renderPack', () => {
  it('renders every bucket with per-item rationale, path, and currency', () => {
    const { lines, write } = collector();

    renderPack({ sessionId: 'sess-1', ts: '2026-06-02T09:00:00.000Z', pack: FIXTURE_PACK }, write);

    const text = lines.join('\n');
    expect(text).toContain('session  sess-1');
    expect(text).toContain('served   2026-06-02T09:00:00.000Z');
    expect(text).toContain('## Episodes');
    expect(text).toContain('## Facts');
    expect(text).toContain('1. we picked webhooks for ingestion because polling was too slow');
    expect(text).toContain(
      'id=ep-1 rank=1 method=vector confidence=0.834 score=0.834 currency=current occurred=2026-06-01T11:00:00.000Z',
    );
    expect(text).toContain(
      'id=ep-2 rank=3 method=activation confidence=0.000 score=0.412 path=session-1 -[PARTICIPATES_IN]-> ep-2 currency=superseded superseded_by=ep-3@2026-06-02T09:00:00.000Z',
    );
    expect(text).toContain('id=fact-1 rank=2 method=bm25 confidence=0.620 score=0.620 currency=current');
  });

  it('lists the cue set, stage timings, and token estimate', () => {
    const { lines, write } = collector();

    renderPack({ sessionId: 'sess-1', ts: '2026-06-02T09:00:00.000Z', pack: FIXTURE_PACK }, write);

    const text = lines.join('\n');
    expect(text).toContain('webhooks ingestion  (query x3)');
    expect(text).toContain('standup  (summary x2)');
    expect(text).toMatch(/cues\s+120\.40/);
    expect(text).toMatch(/embed\s+15\.20/);
    expect(text).toContain('token estimate  128');
  });

  it('marks a degraded pack and an empty pack plainly', () => {
    const { lines, write } = collector();

    renderPack({ sessionId: 'sess-2', ts: '2026-06-02T09:00:00.000Z', pack: EMPTY_PACK }, write);

    const text = lines.join('\n');
    // One line per rung: an empty pack that also lost the graph is an outage, not a miss.
    expect(text).toContain('degraded  cues: timeout');
    expect(text).toContain('degraded  graph: unavailable');
    expect(text).toContain('(empty pack)');
    expect(text).toContain('cues\n  none');
  });

  it('omits the degraded line on a normal pack', () => {
    const { lines, write } = collector();

    renderPack({ sessionId: 'sess-1', ts: '2026-06-02T09:00:00.000Z', pack: FIXTURE_PACK }, write);

    expect(lines.join('\n')).not.toContain('degraded');
  });
});

describe('renderSessionList', () => {
  it('marks the selected session and lists every session with its timestamp', () => {
    const { lines, write } = collector();

    renderSessionList(
      [
        { sessionId: 'sess-2', ts: '2026-06-02T09:00:00.000Z' },
        { sessionId: 'sess-1', ts: '2026-06-01T09:00:00.000Z' },
      ],
      'sess-2',
      write,
    );

    const text = lines.join('\n');
    expect(text).toContain('sessions with packs (2)');
    expect(text).toContain('* sess-2  2026-06-02T09:00:00.000Z');
    expect(text).toContain('  sess-1  2026-06-01T09:00:00.000Z');
  });
});

describe('runLast', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-cli-last-'));
    process.env['AION_SQLITE_PATH'] = join(dir, 'aion.sqlite');
    process.env['AION_LOG_FILE'] = join(dir, 'aion.jsonl');
  });

  afterEach(() => {
    delete process.env['AION_SQLITE_PATH'];
    delete process.env['AION_LOG_FILE'];
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports there is nothing to show against an empty store', async () => {
    const { lines, write } = collector();

    const code = await runLast([], write);

    expect(code).toBe(1);
    expect(lines).toHaveLength(0);
  });

  it('rejects an unknown session id', async () => {
    const store = new SqliteStore({ filePath: process.env['AION_SQLITE_PATH'] ?? '' });
    saveLastPack(store.db, 'sess-1', FIXTURE_PACK, '2026-06-02T09:00:00.000Z');
    store.close();

    const code = await runLast(['--session', 'does-not-exist']);

    expect(code).toBe(1);
  });

  it('with no --session, lists sessions and renders the most recent pack', async () => {
    const store = new SqliteStore({ filePath: process.env['AION_SQLITE_PATH'] ?? '' });
    saveLastPack(store.db, 'sess-older', EMPTY_PACK, '2026-06-01T00:00:00.000Z');
    saveLastPack(store.db, 'sess-newer', FIXTURE_PACK, '2026-06-02T09:00:00.000Z');
    store.close();

    const { lines, write } = collector();
    const code = await runLast([], write);

    expect(code).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('sessions with packs (2)');
    expect(text).toContain('* sess-newer');
    expect(text).toContain('session  sess-newer');
    expect(text).toContain('## Episodes');
  });

  it('with --session, renders that session without the session list', async () => {
    const store = new SqliteStore({ filePath: process.env['AION_SQLITE_PATH'] ?? '' });
    saveLastPack(store.db, 'sess-older', EMPTY_PACK, '2026-06-01T00:00:00.000Z');
    saveLastPack(store.db, 'sess-newer', FIXTURE_PACK, '2026-06-02T09:00:00.000Z');
    store.close();

    const { lines, write } = collector();
    const code = await runLast(['--session', 'sess-older'], write);

    expect(code).toBe(0);
    const text = lines.join('\n');
    expect(text).not.toContain('sessions with packs');
    expect(text).toContain('session  sess-older');
    expect(text).toContain('(empty pack)');
  });

  it('--json emits the stored JSON unchanged', async () => {
    const store = new SqliteStore({ filePath: process.env['AION_SQLITE_PATH'] ?? '' });
    saveLastPack(store.db, 'sess-1', FIXTURE_PACK, '2026-06-02T09:00:00.000Z');
    store.close();

    const { lines, write } = collector();
    const code = await runLast(['--session', 'sess-1', '--json'], write);

    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toEqual(FIXTURE_PACK);
  });
});
