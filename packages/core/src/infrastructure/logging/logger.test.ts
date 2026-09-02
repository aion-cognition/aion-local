import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openLogger } from './logger.js';

describe('openLogger', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-log-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes one JSON object per line to the target path', () => {
    const filePath = join(dir, 'nested', 'aion.jsonl');
    const logger = openLogger({ filePath, level: 'debug', name: 'test' });

    logger.info({ episode_id: 'abc' }, 'stored');
    logger.debug('quiet');

    const lines = readFileSync(filePath, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);

    const first: unknown = JSON.parse(lines[0] ?? '');
    expect(first).toMatchObject({ name: 'test', msg: 'stored', episode_id: 'abc' });
    expect(JSON.parse(lines[1] ?? '')).toMatchObject({ msg: 'quiet' });
  });

  it('opens both stdout (fd 1) and the file when asked, each at the configured level', () => {
    const destinationSpy = vi.spyOn(pino, 'destination');
    const filePath = join(dir, 'aion.jsonl');

    const logger = openLogger({ filePath, level: 'debug', stdout: true });
    logger.debug('both sinks');

    const destCalls = destinationSpy.mock.calls.map(([opts]) => opts);
    expect(destCalls).toContainEqual(expect.objectContaining({ dest: 1, sync: true }));
    expect(destCalls).toContainEqual(expect.objectContaining({ dest: filePath, sync: true }));

    const lines = readFileSync(filePath, 'utf8').trimEnd().split('\n');
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ msg: 'both sinks' });
    destinationSpy.mockRestore();
  });

  // A CLI command writes its answer on fd 1, so a log record teed there lands in the middle of
  // the JSON a caller of `aion last --json` parses.
  it('leaves fd 1 alone unless the caller asks for the tee', () => {
    const destinationSpy = vi.spyOn(pino, 'destination');
    const filePath = join(dir, 'aion.jsonl');

    const logger = openLogger({ filePath, level: 'debug' });
    logger.debug('file only');

    const destCalls = destinationSpy.mock.calls.map(([opts]) => opts);
    expect(destCalls).not.toContainEqual(expect.objectContaining({ dest: 1 }));
    expect(destCalls).toContainEqual(expect.objectContaining({ dest: filePath, sync: true }));

    const lines = readFileSync(filePath, 'utf8').trimEnd().split('\n');
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ msg: 'file only' });
    destinationSpy.mockRestore();
  });

  it('drops records below the configured level', () => {
    const filePath = join(dir, 'aion.jsonl');
    const logger = openLogger({ filePath, level: 'warn' });

    logger.info('suppressed');
    logger.error('kept');

    const lines = readFileSync(filePath, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ msg: 'kept' });
  });
});
