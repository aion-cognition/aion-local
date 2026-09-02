import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  backupPath,
  installHooks,
  parseHooksFlags,
  SettingsUnreadableError,
  statusHooks,
  uninstallHooks,
  type HooksCommandOptions,
} from './hooks-cmd.js';
import { describeAionHooks } from './hooks-settings.js';

const NOW = new Date('2026-08-30T04:05:06.789Z');

describe('parseHooksFlags', () => {
  it('defaults to the full profile, push stop mode, and research capture on', () => {
    expect(parseHooksFlags([])).toEqual({
      profile: 'full',
      withResearchCapture: true,
      stopMode: 'push',
    });
  });

  it('reads every supported flag', () => {
    expect(
      parseHooksFlags(['--profile', 'lite', '--stop-mode', 'instruct', '--no-research-capture']),
    ).toEqual({
      profile: 'lite',
      withResearchCapture: false,
      stopMode: 'instruct',
    });
  });

  it('rejects an unknown option and an unsupported value', () => {
    expect(() => parseHooksFlags(['--force'])).toThrow("unknown option '--force' for hooks");
    expect(() => parseHooksFlags(['--profile', 'medium'])).toThrow(
      "unknown option '--profile' for hooks",
    );
  });
});

describe('backupPath', () => {
  it('stamps the copy with compact UTC so a listing sorts by age', () => {
    expect(backupPath('/home/me/.claude/settings.json', NOW)).toBe(
      '/home/me/.claude/settings.json.aion-20260830T040506Z',
    );
  });
});

describe('hooks install and uninstall', () => {
  let dir: string;
  let repoDir: string;
  let settingsPath: string;
  let written: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-hooks-'));
    repoDir = join(dir, 'repo');
    settingsPath = join(dir, 'home', '.claude', 'settings.json');
    written = [];
    mkdirSync(join(repoDir, 'packages', 'cli', 'dist'), { recursive: true });
    writeFileSync(join(repoDir, 'compose.yaml'), 'name: aion\n');
    writeFileSync(
      join(repoDir, 'packages', 'cli', 'dist', 'hook-main.js'),
      '#!/usr/bin/env node\n',
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function options(overrides: Partial<HooksCommandOptions> = {}): HooksCommandOptions {
    return {
      flags: { profile: 'full', withResearchCapture: false, stopMode: 'push' },
      settingsPath,
      repo: { path: repoDir, verified: true },
      now: NOW,
      ...overrides,
    };
  }

  const write = (line: string): void => {
    written.push(line);
  };

  function settings(): Record<string, unknown> {
    return JSON.parse(readFileSync(settingsPath, 'utf8'));
  }

  it('creates the settings file when there is none', () => {
    expect(installHooks(options(), write)).toBe(0);

    expect(describeAionHooks(settings())).toHaveLength(7);
    expect(written[0]).toContain('aion hooks installed (full)');
  });

  it('preserves foreign hooks and backs the file up before touching it', () => {
    mkdirSync(join(dir, 'home', '.claude'), { recursive: true });
    const original = {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify-send done' }] }] },
      model: 'opus',
    };
    writeFileSync(settingsPath, JSON.stringify(original));

    installHooks(options(), write);

    const merged = settings();
    expect(merged.model).toBe('opus');
    const stop = (merged.hooks as Record<string, unknown[]>).Stop;
    expect(stop?.[0]).toEqual(original.hooks.Stop[0]);
    expect(stop).toHaveLength(2);

    const backup = backupPath(settingsPath, NOW);
    expect(JSON.parse(readFileSync(backup, 'utf8'))).toEqual(original);
  });

  it('replaces its own entries rather than stacking them on a second install', () => {
    installHooks(options(), write);
    installHooks(options(), write);

    expect(describeAionHooks(settings())).toHaveLength(7);
    const backups = readdirSync(join(dir, 'home', '.claude')).filter((name) =>
      name.includes('.aion-'),
    );
    expect(backups).toHaveLength(1);
  });

  it('keeps the older copy when two commands land in the same second', () => {
    mkdirSync(join(dir, 'home', '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ model: 'opus' }));

    installHooks(options(), write);
    uninstallHooks(options(), write);

    expect(JSON.parse(readFileSync(backupPath(settingsPath, NOW), 'utf8'))).toEqual({
      model: 'opus',
    });
  });

  it('adds the research capture entry only when it is asked for', () => {
    installHooks(
      options({ flags: { profile: 'full', withResearchCapture: true, stopMode: 'push' } }),
      write,
    );

    expect(describeAionHooks(settings()).map((row) => row.event)).toContain('PostToolUse');
  });

  it('refuses and names the build when the compiled entry is missing', () => {
    rmSync(join(repoDir, 'packages', 'cli', 'dist', 'hook-main.js'));
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    expect(installHooks(options(), write)).toBe(1);

    expect(existsSync(settingsPath)).toBe(false);
    expect(String(stderr.mock.calls[0]?.[0])).toContain('npm run build');
  });

  it('prints the block to merge by hand when the host repo cannot be reached', () => {
    expect(
      installHooks(options({ repo: { path: '/host/aion-local', verified: false } }), write),
    ).toBe(0);

    expect(existsSync(settingsPath)).toBe(false);
    const block = JSON.parse(written[written.length - 1] ?? '{}');
    expect(Object.keys(block.hooks).sort()).toEqual([
      'PreCompact',
      'PreToolUse',
      'SessionEnd',
      'SessionStart',
      'Stop',
      'SubagentStop',
      'UserPromptSubmit',
    ]);
    expect(block.hooks.SessionStart[0].hooks[0].command).toContain(
      '/host/aion-local/packages/cli/dist/hook-main.js',
    );
  });

  it('removes its own entries and leaves the rest of the file alone', () => {
    mkdirSync(join(dir, 'home', '.claude'), { recursive: true });
    const original = {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify-send done' }] }] },
      model: 'opus',
    };
    writeFileSync(settingsPath, JSON.stringify(original));
    installHooks(options(), write);

    expect(uninstallHooks(options(), write)).toBe(0);

    expect(settings()).toEqual(original);
  });

  it('says so and changes nothing when there is nothing of ours to remove', () => {
    mkdirSync(join(dir, 'home', '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ model: 'opus' }));

    expect(uninstallHooks(options(), write)).toBe(0);

    expect(written[0]).toContain('no aion entries');
    expect(readdirSync(join(dir, 'home', '.claude'))).toEqual(['settings.json']);
  });

  it('reports the installed entries and the state of the build', () => {
    installHooks(options(), write);
    written = [];

    expect(statusHooks(options(), write)).toBe(0);

    expect(written.join('\n')).toContain('SessionStart');
    expect(written[written.length - 1]).toContain('present');
  });

  it('reports the build as uncheckable from inside the container', () => {
    written = [];

    statusHooks(options({ repo: { path: '/host/aion-local', verified: false } }), write);

    expect(written.join('\n')).toContain('not checkable from here');
  });

  it('names invalid JSON distinctly from a read failure, with the parse error as the cause', () => {
    mkdirSync(join(dir, 'home', '.claude'), { recursive: true });
    writeFileSync(settingsPath, '{not json');

    let caught: unknown;
    try {
      statusHooks(options(), write);
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
      statusHooks(options(), write);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SettingsUnreadableError);
    expect((caught as Error).message).toContain('could not be read');
    expect((caught as Error).cause).toBeInstanceOf(Error);
  });
});
