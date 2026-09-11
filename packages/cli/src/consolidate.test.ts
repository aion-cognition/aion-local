import { SqliteStore } from '@aion/core';
import { recordIngest } from '@aion/core/infrastructure/sqlite/migration-cohorts.js';
import { sourceReservedForMigration } from '@aion/core/infrastructure/sqlite/migration-partition.js';
import {
  beginNarrativeMigration,
  captureNarrativeMigrationPage,
  readNarrativeMigration,
} from '@aion/core/infrastructure/sqlite/narrative-migration-job.js';
import { holdNarrativeMigration } from '@aion/core/infrastructure/sqlite/narrative-migration-state.js';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { parseConsolidateFlags, runConsolidate } from './consolidate.js';
import { Substrate } from './substrate.js';

let directory: string;
let path: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'aion-consolidate-cli-'));
  path = join(directory, 'store.sqlite');
  vi.stubEnv('AION_SQLITE_PATH', path);
  vi.stubEnv('AION_LOG_FILE', join(directory, 'cli.jsonl'));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

it('defaults flags-only calls to status and confines execution flags to run', () => {
  expect(parseConsolidateFlags(['--cohort', 'fixed'])).toMatchObject({
    action: 'status',
    cohortId: 'fixed',
  });
  expect(
    parseConsolidateFlags(['run', '--cohort', 'fixed', '--steps', '1', '--refresh']),
  ).toMatchObject({ action: 'run', steps: 1, refresh: true });
  for (const argv of [
    [],
    ['status', '--cohort', 'fixed', '--steps', '2'],
    ['run', '--cohort', 'fixed', '--steps', '0'],
    ['run', '--cohort', 'fixed', '--steps', '257'],
  ]) {
    expect(() => parseConsolidateFlags(argv)).toThrow();
  }
});

it('prints help without constructing a substrate connection or store', async () => {
  const db = vi.spyOn(Substrate.prototype, 'db');
  const connection = vi.spyOn(Substrate.prototype, 'connection');
  const lines: string[] = [];
  expect(await runConsolidate(['--help'], (line) => lines.push(line))).toBe(0);
  expect(lines.join('\n')).toContain('consolidate');
  expect(db).not.toHaveBeenCalled();
  expect(connection).not.toHaveBeenCalled();
});

it('reads a durable status without database initialization, graph access or file changes', async () => {
  const store = new SqliteStore({ filePath: path });
  beginNarrativeMigration(store.db, {
    cohortId: 'fixed',
    now: new Date('2026-09-10T10:00:00Z'),
    policy: {
      maxMembers: 24,
      maxSpanMs: 86400000,
      renderedInputAllowance: 16384,
      partitionPolicyVersion: 1,
    },
  });
  store.close();
  const before = readFileSync(path);
  const db = vi.spyOn(Substrate.prototype, 'db');
  const connection = vi.spyOn(Substrate.prototype, 'connection');
  const lines: string[] = [];
  expect(
    await runConsolidate(['status', '--cohort', 'fixed', '--json'], (line) => lines.push(line)),
  ).toBe(0);
  expect(JSON.parse(lines[0] ?? '')).toMatchObject({
    job: { cohortId: 'fixed', phase: 'archive' },
  });
  expect(db).not.toHaveBeenCalled();
  expect(connection).not.toHaveBeenCalled();
  expect(readFileSync(path)).toEqual(before);
});

it('abandons a captured job without deleting its rows or contacting the graph', async () => {
  const store = new SqliteStore({ filePath: path });
  const now = new Date('2026-09-10T10:00:00Z');
  recordIngest(store.db, 'old', now);
  const job = beginNarrativeMigration(store.db, {
    cohortId: 'abandon-me',
    now,
    policy: {
      maxMembers: 24,
      maxSpanMs: 86400000,
      renderedInputAllowance: 16384,
      partitionPolicyVersion: 1,
    },
  });
  captureNarrativeMigrationPage(store.db, job, ['old'], 'first-page', now);
  expect(sourceReservedForMigration(store.db, 'old')).toBe(true);
  store.close();
  const connection = vi.spyOn(Substrate.prototype, 'connection');
  const lines: string[] = [];
  expect(
    await runConsolidate(['abandon', '--cohort', 'abandon-me', '--json'], (line) =>
      lines.push(line),
    ),
  ).toBe(0);
  expect(connection).not.toHaveBeenCalled();
  const reopened = new SqliteStore({ filePath: path });
  try {
    expect(readNarrativeMigration(reopened.db, 'abandon-me')).toMatchObject({
      state: 'abandoned',
      cursor: 'first-page',
    });
    expect(sourceReservedForMigration(reopened.db, 'old')).toBe(false);
    expect(reopened.db.prepare('SELECT source_id FROM narrative_migration_capture').all()).toEqual([
      { source_id: 'old' },
    ]);
    expect(reopened.db.prepare('SELECT source_id FROM ingest_log').all()).toEqual([
      { source_id: 'old' },
    ]);
  } finally {
    reopened.close();
  }
});

it('reports an absent migration store distinctly without creating it', async () => {
  const lines: string[] = [];
  expect(
    await runConsolidate(['status', '--cohort', 'absent', '--json'], (line) => lines.push(line)),
  ).toBe(1);
  expect(JSON.parse(lines[0] ?? '')).toMatchObject({
    status: 'missing',
    reason: 'store_missing',
    job: null,
  });
});

it('reports an old schema as missing rather than initializing it during status', async () => {
  const legacy = new Database(path);
  legacy.close();
  const before = readFileSync(path);
  const lines: string[] = [];
  expect(
    await runConsolidate(['status', '--cohort', 'old', '--json'], (line) => lines.push(line)),
  ).toBe(1);
  expect(JSON.parse(lines[0] ?? '')).toMatchObject({
    status: 'missing',
    reason: 'schema_missing',
    job: null,
  });
  expect(readFileSync(path)).toEqual(before);
});

it('reports a blocked run without recovering or constructing a provider', async () => {
  const store = new SqliteStore({ filePath: path });
  const now = new Date('2026-09-10T10:00:00Z');
  const job = beginNarrativeMigration(store.db, {
    cohortId: 'blocked',
    now,
    policy: {
      maxMembers: 24,
      maxSpanMs: 86400000,
      renderedInputAllowance: 16384,
      partitionPolicyVersion: 1,
    },
  });
  holdNarrativeMigration(store.db, job, 'capture_member_bound', now);
  store.close();
  const connection = vi.spyOn(Substrate.prototype, 'connection');
  const db = vi.spyOn(Substrate.prototype, 'db');
  const lines: string[] = [];
  expect(
    await runConsolidate(['run', '--cohort', 'blocked', '--json'], (line) => lines.push(line)),
  ).toBe(1);
  expect(JSON.parse(lines[0] ?? '')).toMatchObject({
    status: 'blocked',
    job: { blockedReason: 'capture_member_bound' },
  });
  expect(connection).not.toHaveBeenCalled();
  expect(db).not.toHaveBeenCalled();
});
