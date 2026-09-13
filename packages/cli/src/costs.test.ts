import { appendApiCall, GenerationSpendGuard, SqliteStore } from '@aion/core';
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
    thinkingTokens: 0,
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
    thinkingTokens: 0,
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

function lineStartingWith(lines: readonly string[], prefix: string): string {
  const line = lines.find((candidate) => candidate.startsWith(prefix));
  if (line === undefined) {
    throw new Error(`no line starts with ${prefix}: ${lines.join('\n')}`);
  }
  return line;
}

it('reports cache share for a complete group beside one whose usage failed to parse', async () => {
  appendApiCall(store.db, {
    occurredAt: new Date('2026-09-06T10:00:00Z'),
    model: 'claude-haiku-4-5',
    surface: 'cues',
    inputTokens: 1000,
    outputTokens: 200,
    cacheCreationTokens: 2000,
    cacheReadTokens: 7000,
    thinkingTokens: 0,
    durationMs: 50,
    attempts: 1,
  });
  appendApiCall(store.db, {
    occurredAt: new Date('2026-09-06T11:00:00Z'),
    model: 'claude-haiku-4-5',
    surface: 'cognitive',
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    thinkingTokens: 0,
    durationMs: 1,
    attempts: 1,
    usageError: 'invalid_usage',
  });
  const lines: string[] = [];
  await runCosts([], (line) => lines.push(line));
  expect(lineStartingWith(lines, 'cues')).toContain('70.0%');
  expect(lineStartingWith(lines, 'cognitive')).toContain('unavailable');
  expect(lineStartingWith(lines, 'cognitive')).not.toContain('%');
  expect(lines).toContain('cache effectiveness unavailable: usage parse failures');
});

/**
 * The reasoning column reports what it can add and says what is missing. Zero would read as a
 * group that reasoned for nothing, which is the one thing a response with no breakdown did not
 * say about itself.
 */
it('says the reasoning share is unknown rather than printing it as none', async () => {
  const call = {
    occurredAt: new Date('2026-09-06T10:00:00Z'),
    model: 'claude-haiku-4-5',
    surface: 'cues',
    inputTokens: 1000,
    outputTokens: 200,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    durationMs: 50,
    attempts: 1,
  };
  appendApiCall(store.db, call);
  const unknownOnly: string[] = [];
  await runCosts([], (line) => unknownOnly.push(line));
  expect(lineStartingWith(unknownOnly, 'cues')).toContain('unavailable');

  appendApiCall(store.db, { ...call, surface: 'cognitive', thinkingTokens: 51 });
  const mixed: string[] = [];
  await runCosts([], (line) => mixed.push(line));
  expect(lineStartingWith(mixed, 'cognitive')).toContain('51');
  expect(lineStartingWith(mixed, '2026-09-06')).toContain('51+unknown');
});

it('marks a group unavailable when only some of its calls have unusable usage', async () => {
  appendApiCall(store.db, {
    occurredAt: new Date('2026-09-06T10:00:00Z'),
    model: 'claude-haiku-4-5',
    surface: 'cues',
    inputTokens: 1000,
    outputTokens: 200,
    cacheCreationTokens: 2000,
    cacheReadTokens: 7000,
    thinkingTokens: 0,
    durationMs: 50,
    attempts: 1,
  });
  appendApiCall(store.db, {
    occurredAt: new Date('2026-09-06T11:00:00Z'),
    model: 'claude-haiku-4-5',
    surface: 'cues',
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    thinkingTokens: 0,
    durationMs: 1,
    attempts: 1,
    usageError: 'invalid_usage',
  });
  const lines: string[] = [];
  await runCosts([], (line) => lines.push(line));
  expect(lineStartingWith(lines, 'cues')).toContain('unavailable');
  expect(lineStartingWith(lines, '2026-09-06')).toContain('unavailable');
});

it('reports no share for a complete group that spent no input tokens', async () => {
  appendApiCall(store.db, {
    occurredAt: new Date('2026-09-06T10:00:00Z'),
    model: 'claude-haiku-4-5',
    surface: 'cues',
    inputTokens: 0,
    outputTokens: 200,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    thinkingTokens: 0,
    durationMs: 50,
    attempts: 1,
  });
  const lines: string[] = [];
  await runCosts([], (line) => lines.push(line));
  expect(lineStartingWith(lines, 'cues')).toContain('no-input');
  expect(lineStartingWith(lines, 'cues')).not.toContain('NaN');
  expect(lineStartingWith(lines, 'cues')).not.toContain('unavailable');
});

it('reports cache share for a complete group whose model has no price', async () => {
  appendApiCall(store.db, {
    occurredAt: new Date('2026-09-06T10:00:00Z'),
    model: 'unknown-model',
    surface: 'cues',
    inputTokens: 1000,
    outputTokens: 200,
    cacheCreationTokens: 0,
    cacheReadTokens: 1000,
    thinkingTokens: 0,
    durationMs: 50,
    attempts: 1,
  });
  const lines: string[] = [];
  await runCosts([], (line) => lines.push(line));
  expect(lineStartingWith(lines, 'cues')).toContain('50.0%');
  expect(lineStartingWith(lines, 'cues')).toContain('unpriced');
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
    thinkingTokens: 0,
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

it('prices a batched answer at the batch rate without touching its token counts', async () => {
  appendApiCall(store.db, {
    occurredAt: new Date('2026-09-06T10:00:00Z'),
    model: 'claude-haiku-4-5',
    surface: 'description_freshness',
    requestId: 'msgbatch_1:description_freshness:entity-1:1:abcd',
    pricingTier: 'batch',
    inputTokens: 1000,
    outputTokens: 200,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    thinkingTokens: 0,
    durationMs: 50,
    attempts: 1,
  });
  const lines: string[] = [];
  expect(await runCosts(['--days', '1'], (line) => lines.push(line))).toBe(0);

  const row = lineStartingWith(lines, 'description_freshness');
  // The same 1,000 and 200 the model read and wrote, at half of the $0.001 + $0.001 those
  // tokens cost on the ordinary rate.
  expect(row).toContain('batch');
  expect(row).toContain('1000  200');
  expect(row).toContain('$0.001000');
});

it('prints the day against the ceiling, in flight and all', async () => {
  const guard = new GenerationSpendGuard({ db: store.db, ceilingUsd: 5 });
  const held = guard.hold({
    surface: 'cognitive',
    model: 'claude-haiku-4-5',
    route: 'messages',
    inputTokens: 1000,
    outputTokens: 1000,
    now: new Date('2026-09-06T11:00:00Z'),
  });
  expect('hold' in held).toBe(true);

  const lines: string[] = [];
  expect(await runCosts(['--days', '1'], (line) => lines.push(line))).toBe(0);

  // A commitment is not a charge and the bill above says nothing about it: the request is out
  // and holding its conservative maximum, which is what a caller asking to spend more is
  // measured against.
  expect(lines.join('\n')).toContain(
    'today against the ceiling: $0.006000 of $5.00 committed (1 request(s) in flight holding $0.006000)',
  );
});
