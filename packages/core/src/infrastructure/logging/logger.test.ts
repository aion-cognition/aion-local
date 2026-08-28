import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
