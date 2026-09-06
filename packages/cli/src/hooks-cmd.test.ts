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

import { backupPath, SettingsUnreadableError } from './hook/settings-file.js';
import { describeAionHooks } from './hook/settings.js';
import {
  installHooks,
  parseHooksFlags,
  statusHooks,
  uninstallHooks,
  type HooksCommandOptions,
} from './hooks-cmd.js';

const NOW = new Date('2026-08-30T04:05:06.789Z');

describe('parseHooksFlags', () => {
  it('defaults to claude, the full profile, push stop mode, and research capture on', () => {
    expect(parseHooksFlags([])).toEqual({
      profile: 'full',
      withResearchCapture: true,
      stopMode: 'push',
      harness: 'claude',
    });
  });

  it('reads every supported flag', () => {
    expect(
      parseHooksFlags([
        '--profile',
        'lite',
        '--stop-mode',
        'instruct',
        '--no-research-capture',
        '--harness',
        'codex',
      ]),
    ).toEqual({
      profile: 'lite',
      withResearchCapture: false,
      stopMode: 'instruct',
      harness: 'codex',
    });
  });

  it('rejects an unknown option and an unsupported value', () => {
    expect(() => parseHooksFlags(['--force'])).toThrow("unknown option '--force' for hooks");
    expect(() => parseHooksFlags(['--profile', 'medium'])).toThrow(
      "unknown option '--profile' for hooks",
    );
    expect(() => parseHooksFlags(['--harness', 'cursor'])).toThrow(
      "unknown option '--harness' for hooks",
    );
  });
});

describe('hooks install and uninstall', () => {
  let dir: string;
  let repoDir: string;
  let settingsPath: string;
  let codexDir: string;
  let codexHooksPath: string;
  let codexConfigPath: string;
  let written: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-hooks-'));
    repoDir = join(dir, 'repo');
    settingsPath = join(dir, 'home', '.claude', 'settings.json');
    codexDir = join(dir, 'home', '.codex');
    codexHooksPath = join(codexDir, 'hooks.json');
    codexConfigPath = join(codexDir, 'config.toml');
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
      flags: { profile: 'full', withResearchCapture: false, stopMode: 'push', harness: 'claude' },
      settingsPath,
      codexHooksPath,
      codexConfigPath,
      repo: { path: repoDir, verified: true },
      now: NOW,
      // Every case names its own environment, so a key exported in the developer's shell
      // never decides whether install refuses.
      env: { AION_ANTHROPIC_API_KEY: 'sk-from-env' },
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
      options({
        flags: {
          profile: 'full',
          withResearchCapture: true,
          stopMode: 'push',
          harness: 'claude',
        },
      }),
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

  it('refuses to install when neither the environment nor the repo .env carries a key', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    expect(installHooks(options({ env: {} }), write)).toBe(1);

    expect(existsSync(settingsPath)).toBe(false);
    expect(written).toEqual([]);
    const message = String(stderr.mock.calls[0]?.[0]);
    expect(message).toContain('AION_ANTHROPIC_API_KEY');
    expect(message).toContain('aion init full');
    expect(message).toContain(join(repoDir, '.env'));
  });

  it('leaves an existing settings file and its directory untouched when it refuses', () => {
    mkdirSync(join(dir, 'home', '.claude'), { recursive: true });
    const original = { model: 'opus' };
    writeFileSync(settingsPath, JSON.stringify(original));
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    expect(installHooks(options({ env: {} }), write)).toBe(1);

    expect(settings()).toEqual(original);
    expect(readdirSync(join(dir, 'home', '.claude'))).toEqual(['settings.json']);
  });

  it('refuses without a key instead of printing the block to merge by hand', () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    expect(
      installHooks(
        options({ env: {}, repo: { path: '/host/aion-local', verified: false } }),
        write,
      ),
    ).toBe(1);

    expect(written).toEqual([]);
  });

  it('refuses the lite profile without a key the same way as the full profile', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    expect(
      installHooks(
        options({
          env: {},
          flags: {
            profile: 'lite',
            withResearchCapture: false,
            stopMode: 'push',
            harness: 'claude',
          },
        }),
        write,
      ),
    ).toBe(1);

    expect(existsSync(settingsPath)).toBe(false);
    expect(String(stderr.mock.calls[0]?.[0])).toContain('AION_ANTHROPIC_API_KEY');
  });

  it('reads a blank key as no key at all', () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    writeFileSync(join(repoDir, '.env'), 'AION_ANTHROPIC_API_KEY=\n');

    expect(installHooks(options({ env: { AION_ANTHROPIC_API_KEY: '   ' } }), write)).toBe(1);

    expect(existsSync(settingsPath)).toBe(false);
  });

  it('installs when the key is recorded only in the repo .env', () => {
    writeFileSync(join(repoDir, '.env'), '# comment\nAION_ANTHROPIC_API_KEY="sk-from-file"\n');

    expect(installHooks(options({ env: {} }), write)).toBe(0);

    expect(describeAionHooks(settings())).toHaveLength(7);
  });

  it('removes entries and reports status with no key anywhere', () => {
    installHooks(options(), write);
    written = [];

    expect(statusHooks(options({ env: {} }), write)).toBe(0);
    expect(uninstallHooks(options({ env: {} }), write)).toBe(0);

    expect(written.join('\n')).toContain('SessionStart');
    expect(describeAionHooks(settings())).toHaveLength(0);
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

  describe('on codex', () => {
    const SERVER_BLOCK = '[mcp_servers.aion]\nurl = "http://127.0.0.1:8765/mcp"\n';
    const TRUST_WALKTHROUGH = [
      'codex trusts a hook only after you review it. Run codex, then /hooks, and trust the aion entries.',
      'A reinstall with different flags changes those entries and codex will ask again. Hooks are enabled',
      'by default (features.hooks); if /hooks shows them disabled, enable the feature first.',
    ].join('\n');

    function codexOptions(overrides: Partial<HooksCommandOptions> = {}): HooksCommandOptions {
      return options({
        flags: { profile: 'full', withResearchCapture: false, stopMode: 'push', harness: 'codex' },
        ...overrides,
      });
    }

    function hooksFile(): Record<string, unknown> {
      return JSON.parse(readFileSync(codexHooksPath, 'utf8'));
    }

    function configFile(): string {
      return readFileSync(codexConfigPath, 'utf8');
    }

    it('writes the codex hooks file and creates the config with the server block', () => {
      expect(installHooks(codexOptions(), write)).toBe(0);

      const rows = describeAionHooks(hooksFile());
      expect(rows).toHaveLength(7);
      expect(rows.every((row) => row.command.endsWith('--harness codex'))).toBe(true);
      expect(configFile()).toBe(SERVER_BLOCK);
      expect(existsSync(settingsPath)).toBe(false);
      expect(written[0]).toContain(`aion hooks installed (full) in ${codexHooksPath}`);
    });

    it('reads the mcp port from the environment when one is set', () => {
      installHooks(
        codexOptions({ env: { AION_ANTHROPIC_API_KEY: 'sk-from-env', AION_MCP_PORT: '9100' } }),
        write,
      );

      expect(configFile()).toContain('url = "http://127.0.0.1:9100/mcp"');
    });

    it('prints the trust walkthrough after writing', () => {
      installHooks(codexOptions(), write);

      expect(written.join('\n')).toContain(TRUST_WALKTHROUGH);
    });

    it('leaves the config alone and the hooks file identical on a second install', () => {
      installHooks(codexOptions(), write);
      const first = hooksFile();
      const config = configFile();
      written = [];

      installHooks(codexOptions(), write);

      expect(hooksFile()).toEqual(first);
      expect(configFile()).toBe(config);
      expect(written.join('\n')).toContain('already in');
    });

    it('appends to a config that has other servers and backs it up first', () => {
      mkdirSync(codexDir, { recursive: true });
      const original = 'model = "gpt-5"\n\n[mcp_servers.other]\nurl = "http://127.0.0.1:1/mcp"\n';
      writeFileSync(codexConfigPath, original);

      installHooks(codexOptions(), write);

      expect(configFile()).toBe(`${original}\n${SERVER_BLOCK}`);
      expect(readFileSync(backupPath(codexConfigPath, NOW), 'utf8')).toBe(original);
    });

    it('refuses without a key and writes neither file', () => {
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      expect(installHooks(codexOptions({ env: {} }), write)).toBe(1);

      expect(existsSync(codexHooksPath)).toBe(false);
      expect(existsSync(codexConfigPath)).toBe(false);
      expect(written).toEqual([]);
      expect(String(stderr.mock.calls[0]?.[0])).toContain('AION_ANTHROPIC_API_KEY');
    });

    it('removes the hook entries and says the server block stays', () => {
      installHooks(codexOptions(), write);
      written = [];

      expect(uninstallHooks(codexOptions(), write)).toBe(0);

      expect(describeAionHooks(hooksFile())).toHaveLength(0);
      expect(configFile()).toBe(SERVER_BLOCK);
      const out = written.join('\n');
      expect(out).toContain(`removed 7 entries from ${codexHooksPath}`);
      expect(out).toContain(codexConfigPath);
    });

    it('reports the entries, the server block, and the build', () => {
      installHooks(codexOptions(), write);
      written = [];

      expect(statusHooks(codexOptions(), write)).toBe(0);

      const out = written.join('\n');
      expect(out).toContain(`settings: ${codexHooksPath}`);
      expect(out).toContain('SessionStart');
      expect(out).toContain(`[mcp_servers.aion] present in ${codexConfigPath}`);
      expect(written[written.length - 1]).toContain('hook-main.js present');
    });

    it('reports a config that carries no server block', () => {
      expect(statusHooks(codexOptions(), write)).toBe(0);

      const out = written.join('\n');
      expect(out).toContain('no aion entries');
      expect(out).toContain(`[mcp_servers.aion] missing from ${codexConfigPath}`);
    });

    it('prints both blocks to merge by hand when the host repo cannot be reached', () => {
      expect(
        installHooks(codexOptions({ repo: { path: '/host/aion-local', verified: false } }), write),
      ).toBe(0);

      expect(existsSync(codexHooksPath)).toBe(false);
      expect(existsSync(codexConfigPath)).toBe(false);
      const block = JSON.parse(written.find((line) => line.startsWith('{')) ?? '{}');
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
        '/host/aion-local/packages/cli/dist/hook-main.js session-start --harness codex',
      );
      const out = written.join('\n');
      expect(out).toContain('hooks.json');
      expect(out).toContain(SERVER_BLOCK.trimEnd());
      expect(out).toContain('config.toml');
    });
  });
});
