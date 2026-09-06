import { appendApiCall, SqliteStore } from '@aion/core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { runCosts } from './costs.js';

let dir: string;
let store: SqliteStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-costs-'));
  vi.stubEnv('AION_SQLITE_PATH', join(dir, 'aion.sqlite'));
  store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-06T12:00:00Z'));
});
afterEach(() => {
  store.close();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

it('renders each UTC day and surface with all token classes priced once', async () => {
  appendApiCall(store.db, {
    occurredAt: new Date('2026-09-06T10:00:00Z'),
    model: 'claude-haiku-4-5',
    surface: 'cues',
    inputTokens: 1000,
    outputTokens: 200,
    cacheCreationTokens: 2000,
    cacheReadTokens: 7000,
    durationMs: 50,
    attempts: 1,
  });
  const lines: string[] = [];
  expect(await runCosts(['--days', '1'], (line) => lines.push(line))).toBe(0);
  const output = lines.join('\n');
  expect(output).toContain('2026-09-06');
  expect(output).toContain('cues');
  expect(output).toContain('$0.005200');
  expect(output).toContain('7000 / 10000 input tokens (70.0%)');
});

it('does not price an unknown model as free or as Haiku', async () => {
  appendApiCall(store.db, {
    occurredAt: new Date(),
    model: 'unknown-model',
    surface: 'unlabeled',
    inputTokens: 100,
    outputTokens: 20,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    durationMs: 50,
    attempts: 1,
  });
  const lines: string[] = [];
  await runCosts([], (line) => lines.push(line));
  expect(lines.join('\n')).toContain('unpriced');
  expect(lines.join('\n')).toContain('unknown-model');
});

it('rejects zero, fractional, missing, and nonnumeric day counts', async () => {
  for (const value of ['0', '1.5', 'no', 'Infinity']) {
    expect(await runCosts(['--days', value], () => undefined)).toBe(1);
  }
  expect(await runCosts(['--days'], () => undefined)).toBe(1);
});

it('marks unknown charges instead of presenting invalid usage as zero spend', async () => {
  appendApiCall(store.db, {
    occurredAt: new Date(),
    model: 'claude-haiku-4-5',
    surface: 'cognitive',
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    durationMs: 1,
    attempts: 1,
    usageError: 'invalid_usage',
  });
  const lines: string[] = [];
  await runCosts([], (line) => lines.push(line));
  const output = lines.join('\n');
  expect(output).toContain('usage-errors');
  expect(output).toContain('estimated total: $0.000000 + unknown charges (1 usage parse failures)');
  expect(output).toContain('cache effectiveness unavailable: usage parse failures');
  expect(output).not.toContain('no metered API calls');
});
