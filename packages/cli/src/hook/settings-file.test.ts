import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  backupPath,
  backupSettings,
  claudeSettingsPath,
  codexHooksPath,
  readSettings,
  SettingsUnreadableError,
  writeSettings,
} from './settings-file.js';

const NOW = new Date('2026-08-30T04:05:06.789Z');

describe('claudeSettingsPath', () => {
  it('names the file under the home directory it is given', () => {
    expect(claudeSettingsPath('/home/me')).toBe('/home/me/.claude/settings.json');
  });
});

describe('codexHooksPath', () => {
  it('names the file under .codex in the home directory it is given', () => {
    expect(codexHooksPath('/home/me', {})).toBe('/home/me/.codex/hooks.json');
  });

  it('follows CODEX_HOME when the environment sets one', () => {
    expect(codexHooksPath('/home/me', { CODEX_HOME: '/custom' })).toBe('/custom/hooks.json');
  });

  it('falls back to the home directory when CODEX_HOME holds only blanks', () => {
    expect(codexHooksPath('/home/me', { CODEX_HOME: '  ' })).toBe('/home/me/.codex/hooks.json');
  });
});

describe('backupPath', () => {
  it('stamps the copy with compact UTC so a listing sorts by age', () => {
    expect(backupPath('/home/me/.claude/settings.json', NOW)).toBe(
      '/home/me/.claude/settings.json.aion-20260830T040506Z',
    );
  });
});

describe('the settings file', () => {
  let dir: string;
  let settingsPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-settings-'));
    settingsPath = join(dir, '.claude', 'settings.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads a file that is not there as an empty object', () => {
    expect(readSettings(settingsPath)).toEqual({});
  });

  it('reads back what was written, under a directory it created itself', () => {
    writeSettings(settingsPath, { model: 'opus' });

    expect(readSettings(settingsPath)).toEqual({ model: 'opus' });
    expect(readFileSync(settingsPath, 'utf8').endsWith('\n')).toBe(true);
  });

  it('names invalid JSON distinctly from a read failure, with the parse error as the cause', () => {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(settingsPath, '{not json');

    let caught: unknown;
    try {
      readSettings(settingsPath);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SettingsUnreadableError);
    expect((caught as Error).message).toContain('is not valid JSON');
    expect((caught as Error).cause).toBeInstanceOf(Error);
  });

  it('names a read failure distinctly from invalid JSON, with the read error as the cause', () => {
    // A directory at the settings path is unreadable as a file (EISDIR), the portable way to
    // force `readFileSync` itself to throw, ahead of anything that parses what it returned.
    mkdirSync(settingsPath, { recursive: true });

    let caught: unknown;
    try {
      readSettings(settingsPath);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SettingsUnreadableError);
    expect((caught as Error).message).toContain('could not be read');
    expect((caught as Error).cause).toBeInstanceOf(Error);
  });

  it('copies the current file aside and names the copy it made', () => {
    writeSettings(settingsPath, { model: 'opus' });

    expect(backupSettings(settingsPath, NOW)).toBe(backupPath(settingsPath, NOW));
    expect(JSON.parse(readFileSync(backupPath(settingsPath, NOW), 'utf8'))).toEqual({
      model: 'opus',
    });
  });

  it('copies nothing when there is no file yet', () => {
    expect(backupSettings(settingsPath, NOW)).toBeUndefined();
    expect(existsSync(backupPath(settingsPath, NOW))).toBe(false);
  });

  it('keeps the older copy when two writes land in the same second', () => {
    writeSettings(settingsPath, { model: 'opus' });
    backupSettings(settingsPath, NOW);
    writeSettings(settingsPath, { model: 'haiku' });

    expect(backupSettings(settingsPath, NOW)).toBeUndefined();
    expect(JSON.parse(readFileSync(backupPath(settingsPath, NOW), 'utf8'))).toEqual({
      model: 'opus',
    });
  });
});
