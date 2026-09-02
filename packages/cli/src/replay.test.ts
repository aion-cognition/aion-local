import { loadConfig, PIPELINE_VERSION, SqliteStore } from '@aion/core';
import {
  ARCHIVE_SCHEMA_VERSION,
  insertExperience,
} from '@aion/core/infrastructure/sqlite/experience-archive.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  defaultSubstrateRefusal,
  parseReplayFlags,
  runReplayCommand,
  type ReplayFlags,
} from './replay.js';

const SCRATCH_ENV = {
  AION_SQLITE_PATH: '/scratch/aion.sqlite',
  AION_NEO4J_URI: 'bolt://localhost:7688',
};

function collector(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

describe('parseReplayFlags', () => {
  it('defaults to ls over the stale rows with no confirmation', () => {
    expect(parseReplayFlags([])).toEqual({
      subcommand: 'ls',
      all: false,
      stale: true,
      live: false,
      yes: false,
      json: false,
    });
  });

  it('reads every option', () => {
    expect(
      parseReplayFlags([
        'run',
        '--all',
        '--episode',
        'e-1',
        '--session',
        's-1',
        '--limit',
        '9',
        '--batch',
        '3',
        '--live',
        '--yes',
        '--json',
      ]),
    ).toEqual({
      subcommand: 'run',
      all: true,
      stale: false,
      episode: 'e-1',
      session: 's-1',
      limit: 9,
      batch: 3,
      live: true,
      yes: true,
      json: true,
    });
  });

  it('reads --stale as the explicit spelling of the default, not a distinct selection', () => {
    expect(parseReplayFlags(['run', '--stale']).stale).toBe(true);
    expect(parseReplayFlags(['run']).stale).toBe(true);
    expect(parseReplayFlags(['run', '--all']).stale).toBe(false);
  });

  it('rejects an unknown subcommand, option, missing value, or bad count', () => {
    expect(() => parseReplayFlags(['redo'])).toThrow("unknown replay subcommand 'redo'");
    expect(() => parseReplayFlags(['run', '--everything'])).toThrow(
      "unknown option '--everything' for replay",
    );
    expect(() => parseReplayFlags(['run', '--episode'])).toThrow('--episode needs a value');
    expect(() => parseReplayFlags(['run', '--limit', 'lots'])).toThrow(
      "--limit got 'lots', expected a positive integer",
    );
    expect(() => parseReplayFlags(['run', '--batch', '0'])).toThrow(
      "--batch got '0', expected a positive integer",
    );
  });

  it('rejects asking for both selections at once', () => {
    expect(() => parseReplayFlags(['run', '--all', '--stale'])).toThrow(
      '--all and --stale select different rows',
    );
  });
});

describe('the scratch-substrate gate', () => {
  function flagsOf(overrides: Partial<ReplayFlags> = {}): ReplayFlags {
    return {
      subcommand: 'run',
      all: false,
      stale: true,
      live: false,
      yes: false,
      json: false,
      ...overrides,
    };
  }

  it('refuses the shipped substrate and names what it would have written to', () => {
    const refusal = defaultSubstrateRefusal(loadConfig({}), flagsOf());

    expect(refusal).toContain('sqlite=/data/aion.sqlite');
    expect(refusal).toContain('neo4j=bolt://neo4j:7687');
    expect(refusal).toContain('AION_SQLITE_PATH and AION_NEO4J_URI');
    expect(refusal).toContain('--live --yes');
  });

  it('refuses when only one half of the substrate has moved', () => {
    const sqliteOnly = defaultSubstrateRefusal(
      loadConfig({ AION_SQLITE_PATH: SCRATCH_ENV.AION_SQLITE_PATH }),
      flagsOf(),
    );
    const neo4jOnly = defaultSubstrateRefusal(
      loadConfig({ AION_NEO4J_URI: SCRATCH_ENV.AION_NEO4J_URI }),
      flagsOf(),
    );

    expect(sqliteOnly).toContain('AION_NEO4J_URI still point at the default');
    expect(neo4jOnly).toContain('AION_SQLITE_PATH still point at the default');
  });

  it('lets a scratch substrate through untouched', () => {
    expect(defaultSubstrateRefusal(loadConfig(SCRATCH_ENV), flagsOf())).toBeUndefined();
  });

  it('lets the shipped substrate through only on --live --yes', () => {
    const config = loadConfig({});

    expect(defaultSubstrateRefusal(config, flagsOf({ live: true }))).toBeDefined();
    expect(defaultSubstrateRefusal(config, flagsOf({ yes: true }))).toBeDefined();
    expect(defaultSubstrateRefusal(config, flagsOf({ live: true, yes: true }))).toBeUndefined();
  });
});

describe('aion replay against a seeded archive', () => {
  let dir: string;
  let store: SqliteStore;

  function archive(index: number, pipelineVersion: string, occurredAt: string): void {
    insertExperience(store.db, {
      schemaVersion: ARCHIVE_SCHEMA_VERSION,
      pipelineVersion,
      identity: 'cli-replay-session',
      sessionId: 'cli-replay-session',
      episodeId: `episode-${String(index)}`,
      contentHash: `hash-${String(index)}`,
      occurredAt,
      archivedAt: '2026-09-01T12:00:00.000Z',
      payload: { summary: `experience ${String(index)}` },
    });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-cli-replay-'));
    process.env.AION_SQLITE_PATH = join(dir, 'aion.sqlite');
    process.env.AION_LOG_FILE = join(dir, 'aion.jsonl');
    process.env.AION_LOG_LEVEL = 'fatal';
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
    archive(0, PIPELINE_VERSION, '2026-01-01T08:00:00.000Z');
    archive(1, 'v0', '2026-01-02T08:00:00.000Z');
    archive(2, 'v0', '2026-01-03T08:00:00.000Z');
  });

  afterEach(() => {
    store.close();
    delete process.env.AION_SQLITE_PATH;
    delete process.env.AION_NEO4J_URI;
    delete process.env.AION_LOG_FILE;
    delete process.env.AION_LOG_LEVEL;
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('counts the archive by pipeline version and names the span it covers', async () => {
    const { lines, write } = collector();

    await expect(runReplayCommand(['ls'], write)).resolves.toBe(0);

    expect(lines).toEqual([
      `pipeline   ${PIPELINE_VERSION}`,
      'archived   3 experiences, 2 stale',
      '  v0         2',
      `  ${PIPELINE_VERSION.padEnd(10)} 1`,
      'occurred   2026-01-01T08:00:00.000Z to 2026-01-03T08:00:00.000Z',
    ]);
  });

  it('answers ls as one json document', async () => {
    const { lines, write } = collector();

    await expect(runReplayCommand(['ls', '--json'], write)).resolves.toBe(0);

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      pipeline_version: PIPELINE_VERSION,
      total: 3,
      stale: 2,
      by_version: [
        { version: 'v0', count: 2 },
        { version: PIPELINE_VERSION, count: 1 },
      ],
      oldest_occurred_at: '2026-01-01T08:00:00.000Z',
      newest_occurred_at: '2026-01-03T08:00:00.000Z',
    });
  });

  // The graph half is still the shipped default here, which is the whole point: half a scratch
  // substrate is not a scratch substrate.
  it('refuses to run against the shipped graph and writes nothing', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const { lines, write } = collector();

    await expect(runReplayCommand(['run'], write)).resolves.toBe(1);

    expect(String(stderr.mock.calls[0]?.[0])).toContain(
      'AION_NEO4J_URI still point at the default',
    );
    expect(lines).toEqual([]);
  });

  it('refuses a scratch substrate that has never been initialized', async () => {
    process.env.AION_NEO4J_URI = SCRATCH_ENV.AION_NEO4J_URI;
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const { lines, write } = collector();

    await expect(runReplayCommand(['run'], write)).resolves.toBe(1);

    const said = String(stderr.mock.calls[0]?.[0]);
    expect(said).toContain('no schema on this substrate');
    expect(said).toContain('run `aion init` against it first');
    expect(lines).toEqual([]);
  });

  it('prints the usage line for --help without opening the substrate', async () => {
    const { lines, write } = collector();

    await expect(runReplayCommand(['--help'], write)).resolves.toBe(0);

    expect(lines[0]).toContain('usage: aion replay [ls | run]');
  });
});

describe('aion replay ls against an archive that holds nothing', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-cli-replay-empty-'));
    process.env.AION_SQLITE_PATH = join(dir, 'aion.sqlite');
    process.env.AION_LOG_FILE = join(dir, 'aion.jsonl');
    process.env.AION_LOG_LEVEL = 'fatal';
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    delete process.env.AION_SQLITE_PATH;
    delete process.env.AION_LOG_FILE;
    delete process.env.AION_LOG_LEVEL;
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports the empty counts and names no span', async () => {
    const { lines, write } = collector();

    await expect(runReplayCommand(['ls'], write)).resolves.toBe(0);

    expect(lines).toEqual([`pipeline   ${PIPELINE_VERSION}`, 'archived   0 experiences, 0 stale']);
  });

  it('answers the same shape in json, with both span fields null', async () => {
    const { lines, write } = collector();

    await expect(runReplayCommand(['ls', '--json'], write)).resolves.toBe(0);

    expect(JSON.parse(lines[0] ?? '')).toEqual({
      pipeline_version: PIPELINE_VERSION,
      total: 0,
      stale: 0,
      by_version: [],
      oldest_occurred_at: null,
      newest_occurred_at: null,
    });
  });
});
