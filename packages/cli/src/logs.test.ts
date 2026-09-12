import { mkdtempSync, renameSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { followLog, parseLogsFlags, passesLevel, readTail } from './logs.js';

let dir: string;
let filePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-logs-'));
  filePath = join(dir, 'aion.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function record(level: number, msg: string): string {
  return `${JSON.stringify({ level, time: '2026-09-12T12:00:00.000Z', msg })}\n`;
}

describe('parseLogsFlags', () => {
  it('defaults to the last fifty lines, no filter, no follow', () => {
    expect(parseLogsFlags([])).toEqual({ lines: 50, level: undefined, follow: false });
  });

  it('takes the count, the floor and the follow flag', () => {
    expect(parseLogsFlags(['-n', '5', '--level', 'warn', '-f'])).toEqual({
      lines: 5,
      level: 'warn',
      follow: true,
    });
  });

  it('refuses a count that is not one and a level that is not a level', () => {
    expect(() => parseLogsFlags(['-n', 'lots'])).toThrow('positive whole number');
    expect(() => parseLogsFlags(['-n', '0'])).toThrow('positive whole number');
    expect(() => parseLogsFlags(['--level', 'shout'])).toThrow('trace, debug, info');
  });
});

describe('the level filter', () => {
  it('keeps a record at or above the floor', () => {
    expect(passesLevel(record(40, 'warned'), 'warn')).toBe(true);
    expect(passesLevel(record(50, 'failed'), 'warn')).toBe(true);
    expect(passesLevel(record(30, 'noted'), 'warn')).toBe(false);
  });

  it('keeps everything when there is no floor, and keeps what is not a record', () => {
    expect(passesLevel(record(10, 'traced'), undefined)).toBe(true);
    // A crash somebody wrote into the file is exactly what a person reading logs wants.
    expect(passesLevel('Error: ENOENT: no such file or directory', 'error')).toBe(true);
  });
});

describe('reading the file', () => {
  it('reads what is there, and from an offset when following', () => {
    writeFileSync(filePath, record(30, 'first'));
    const first = readTail(filePath);

    expect(first.text).toContain('first');
    appendFileSync(filePath, record(30, 'second'));

    const next = readTail(filePath, first.size);
    expect(next.text).toContain('second');
    expect(next.text).not.toContain('first');
  });
});

describe('following', () => {
  it('picks up what is appended', async () => {
    writeFileSync(filePath, record(30, 'first'));
    const said: string[] = [];
    const start = readTail(filePath);
    let ticks = 0;

    const following = followLog(
      filePath,
      start.size,
      undefined,
      (line) => said.push(line),
      () => {
        ticks += 1;
        return ticks > 3;
      },
    );
    appendFileSync(filePath, record(30, 'appended'));
    await following;

    expect(said.join('\n')).toContain('appended');
  });

  it('survives the file being rotated under it', async () => {
    // What the logger does when the window closes: rename the file and open a fresh one. Reading
    // on from the old offset would skip the new file's first records.
    writeFileSync(filePath, `${record(30, 'old')}${record(30, 'older')}`);
    const said: string[] = [];
    const start = readTail(filePath);
    let ticks = 0;

    const following = followLog(
      filePath,
      start.size,
      undefined,
      (line) => said.push(line),
      () => {
        ticks += 1;
        return ticks > 4;
      },
    );
    renameSync(filePath, `${filePath}.1`);
    writeFileSync(filePath, record(30, 'after the roll'));
    await following;

    expect(said.join('\n')).toContain('log rotated');
    expect(said.join('\n')).toContain('after the roll');
  });

  it('filters what it follows by the same floor', async () => {
    writeFileSync(filePath, record(30, 'first'));
    const said: string[] = [];
    const start = readTail(filePath);
    let ticks = 0;

    const following = followLog(
      filePath,
      start.size,
      'error',
      (line) => said.push(line),
      () => {
        ticks += 1;
        return ticks > 3;
      },
    );
    appendFileSync(filePath, `${record(30, 'noise')}${record(50, 'the failure')}`);
    await following;

    expect(said.join('\n')).toContain('the failure');
    expect(said.join('\n')).not.toContain('noise');
  });
});
