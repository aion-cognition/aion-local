import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { enforceLogRetention, openLogger, ROLLED_LOG_SUFFIX } from './logger.js';

/**
 * The file log ages out against its own modification time, with a clock the caller supplies.
 * Scratch directories only: nothing here touches a real data root.
 */

const NOW = new Date('2026-09-12T12:00:00.000Z');

let dir: string;
let filePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-log-retention-'));
  filePath = join(dir, 'aion.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(path: string, ageDays: number): void {
  writeFileSync(path, `{"level":30,"msg":"${String(ageDays)} days old"}\n`);
  const at = new Date(NOW.getTime() - ageDays * 24 * 60 * 60 * 1000);
  utimesSync(path, at, at);
}

describe('enforceLogRetention', () => {
  it('leaves a file inside the window alone', () => {
    write(filePath, 0.5);

    expect(enforceLogRetention(filePath, 1, NOW)).toEqual({ rolled: false, pruned: false });
    expect(readFileSync(filePath, 'utf8')).toContain('0.5 days old');
    expect(existsSync(`${filePath}${ROLLED_LOG_SUFFIX}`)).toBe(false);
  });

  it('rolls a file past the window, so the next open starts a fresh one', () => {
    write(filePath, 2);

    expect(enforceLogRetention(filePath, 1, NOW)).toEqual({ rolled: true, pruned: false });
    expect(existsSync(filePath)).toBe(false);
    expect(readFileSync(`${filePath}${ROLLED_LOG_SUFFIX}`, 'utf8')).toContain('2 days old');
  });

  it('takes fractions, which is what a retention under a day means', () => {
    write(filePath, 0.5);

    expect(enforceLogRetention(filePath, 0.25, NOW)).toEqual({ rolled: true, pruned: false });
  });

  it('deletes a rolled copy that is itself past the window', () => {
    write(filePath, 0.1);
    write(`${filePath}${ROLLED_LOG_SUFFIX}`, 3);

    expect(enforceLogRetention(filePath, 1, NOW)).toEqual({ rolled: false, pruned: true });
    expect(existsSync(`${filePath}${ROLLED_LOG_SUFFIX}`)).toBe(false);
    expect(existsSync(filePath)).toBe(true);
  });

  it('keeps at most the current window and the one before it', () => {
    write(filePath, 2);
    write(`${filePath}${ROLLED_LOG_SUFFIX}`, 0.1);

    // The rolled copy is young, so it is replaced rather than kept beside a third file: two files
    // is the whole history this keeps.
    expect(enforceLogRetention(filePath, 1, NOW)).toEqual({ rolled: true, pruned: false });
    expect(readFileSync(`${filePath}${ROLLED_LOG_SUFFIX}`, 'utf8')).toContain('2 days old');
    expect(existsSync(`${filePath}.2`)).toBe(false);
  });

  it('says nothing happened when there is no file yet', () => {
    expect(enforceLogRetention(filePath, 1, NOW)).toEqual({ rolled: false, pruned: false });
  });
});

describe('openLogger', () => {
  it('ages the file out before it opens, and records that it did', () => {
    // The first start after an upgrade is the case: whatever the old build left is older than the
    // window, and the line saying so is the only notice anybody gets.
    write(filePath, 5);

    const logger = openLogger({ filePath, level: 'info', retentionDays: 1, now: () => NOW });
    logger.info('after');

    expect(readFileSync(`${filePath}${ROLLED_LOG_SUFFIX}`, 'utf8')).toContain('5 days old');
    const fresh = readFileSync(filePath, 'utf8');
    expect(fresh).toContain('file log aged out');
    expect(fresh).toContain('after');
    expect(fresh).not.toContain('5 days old');
  });

  it('says nothing on an ordinary open', () => {
    write(filePath, 0.1);

    openLogger({ filePath, level: 'info', retentionDays: 1, now: () => NOW }).info('after');

    expect(readFileSync(filePath, 'utf8')).not.toContain('file log aged out');
  });

  it('leaves the file alone when no retention is configured', () => {
    write(filePath, 30);

    openLogger({ filePath, level: 'info' }).info('after');

    expect(readFileSync(filePath, 'utf8')).toContain('30 days old');
  });
});
