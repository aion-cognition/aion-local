import { SqliteStore } from '@aion/core';
import { beginNarrativeMigration } from '@aion/core/infrastructure/sqlite/narrative-migration-job.js';
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
