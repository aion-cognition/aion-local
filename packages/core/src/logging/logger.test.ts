import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_LOG_FILE,
  DEFAULT_LOG_LEVEL,
  logTargetFromEnv,
  openLogger,
} from './logger.js';

describe('logTargetFromEnv', () => {
  it('falls back to the in-container defaults', () => {
    expect(logTargetFromEnv({})).toEqual({
      filePath: DEFAULT_LOG_FILE,
      level: DEFAULT_LOG_LEVEL,
    });
  });

  it('takes the path and level from AION_* overrides', () => {
    const target = logTargetFromEnv({
      AION_LOG_FILE: '/somewhere/else.jsonl',
      AION_LOG_LEVEL: 'debug',
    });
    expect(target).toEqual({ filePath: '/somewhere/else.jsonl', level: 'debug' });
  });

  it('ignores a level that is not a pino level', () => {
    expect(logTargetFromEnv({ AION_LOG_LEVEL: 'chatty' }).level).toBe(DEFAULT_LOG_LEVEL);
  });
});

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
