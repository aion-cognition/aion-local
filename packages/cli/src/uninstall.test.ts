import { DEFAULTS } from '@aion/core';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { describeAionHooks } from './hook/settings.js';
import { installHooks, type HooksCommandOptions } from './hooks-cmd.js';
import type { HostActions, HostResult } from './host-actions.js';
import { INSTALL_MANIFEST_VERSION, type InstallManifest } from './install-manifest.js';
import { NEO4J_SETTINGS } from './native-graph.js';
import { installedModelTags, planUninstall, sharedToolCommands } from './uninstall-plan.js';
import { executeUninstall, stripOwnedSettings, writePlan } from './uninstall.js';

/**
 * The removal logic against scratch directories, with launchctl and compose behind seams. Nothing
 * here unloads a job, runs compose, or removes anything outside a temp directory.
 */

let dir: string;
/** Never written unless a test installs into it; a path that does not exist yet is what most of
 *  these plans see, and it must not put a claude hooks item in front of them. */
let settingsPath: string;

/** What a plain local install pulled, which is what the plan is told rather than asked to guess. */
const MODELS = [DEFAULTS.anthropic.model, DEFAULTS.anthropic.model, DEFAULTS.models.embed];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-uninstall-'));
  settingsPath = join(dir, 'home', '.claude', 'settings.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function scripted(result: HostResult = { ok: true, stdout: '', stderr: '' }): {
  actions: HostActions;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    actions: {
      run: (program, args) => {
        calls.push([program, ...args].join(' '));
        return Promise.resolve(result);
      },
      fetch: () => Promise.reject(new Error('no fetch in this path')),
    },
  };
}

function manifest(over: Partial<InstallManifest> = {}): InstallManifest {
  return {
    version: INSTALL_MANIFEST_VERSION,
    profile: 'native',
    recordedAt: '2026-09-12T12:00:00.000Z',
    repoDir: join(dir, 'repo'),
    dataDir: join(dir, '.aion'),
    ...over,
  };
}

describe('the plan', () => {
  it('removes the data root and says what it is', () => {
    mkdirSync(join(dir, '.aion'), { recursive: true });

    const items = planUninstall({
      profile: 'native',
      dataDir: join(dir, '.aion'),
      manifest: manifest(),
      launchAgentPath: join(dir, 'absent.plist'),
      platform: 'darwin',
      models: MODELS,
      settingsPath,
    });

    const root = items.find((item) => item.what === 'data root');
    expect(root).toMatchObject({ action: 'remove' });
    expect(root?.why).toContain('memory store');
  });

  it('leaves out what is not there, which is what a half install looks like', () => {
    // init can stop at any step, and the thing that follows a failed init is usually this.
    const items = planUninstall({
      profile: 'native',
      dataDir: join(dir, 'never-made'),
      manifest: undefined,
      launchAgentPath: join(dir, 'absent.plist'),
      platform: 'darwin',
      models: MODELS,
      settingsPath,
    });

    expect(items.filter((item) => item.action === 'remove')).toEqual([]);
  });

  it('removes the plugin jar this install downloaded and not one it found', () => {
    const jar = join(dir, 'neo4j-graph-data-science-2026.08.1.jar');
    writeFileSync(jar, 'jar');

    const ours = planUninstall({
      profile: 'native',
      dataDir: join(dir, 'nothing'),
      manifest: manifest({ gdsJar: jar }),
      launchAgentPath: join(dir, 'absent.plist'),
      platform: 'darwin',
      models: MODELS,
      settingsPath,
    });
    expect(ours.some((item) => item.what === 'graph-data-science jar')).toBe(true);

    // The same jar on disk, with no record that we put it there.
    const theirs = planUninstall({
      profile: 'native',
      dataDir: join(dir, 'nothing'),
      manifest: manifest(),
      launchAgentPath: join(dir, 'absent.plist'),
      platform: 'darwin',
      models: MODELS,
      settingsPath,
    });
    expect(theirs.some((item) => item.what === 'graph-data-science jar')).toBe(false);
  });

  it('keeps the shared tools, and names the commands instead', () => {
    const items = planUninstall({
      profile: 'native',
      dataDir: join(dir, 'nothing'),
      manifest: manifest({ neo4jHome: '/opt/homebrew/opt/neo4j/libexec' }),
      launchAgentPath: join(dir, 'absent.plist'),
      platform: 'darwin',
      models: MODELS,
      settingsPath,
    });

    const server = items.find((item) => item.what === 'neo4j server');
    expect(server?.action).toBe('keep');
    expect(server?.commands).toEqual(sharedToolCommands(MODELS));
    expect(sharedToolCommands(MODELS).join('\n')).toContain('ollama rm');
  });

  /**
   * The hint is a command an operator runs on their own machine, so it has to name the tags this
   * install actually pulled. Typed against the defaults of the day, it names somebody else's
   * models on every install that changed one and offers to remove them.
   */
  it('names the models this install configured rather than the defaults it shipped with', () => {
    const items = planUninstall({
      profile: 'native',
      dataDir: join(dir, 'nothing'),
      manifest: manifest({ neo4jHome: '/opt/homebrew/opt/neo4j/libexec' }),
      launchAgentPath: join(dir, 'absent.plist'),
      platform: 'darwin',
      models: ['qwen3:14b', 'snowflake-arctic-embed2'],
      settingsPath,
    });

    const server = items.find((item) => item.what === 'neo4j server');
    expect(server?.commands?.join('\n')).toContain('ollama rm qwen3:14b snowflake-arctic-embed2');
    expect(server?.commands?.join('\n')).not.toContain('qwen3:1.7b');
  });

  it('names the one tag this install pulled, whatever the key says', () => {
    const custom = { ...DEFAULTS, models: { ...DEFAULTS.models, embed: 'some-other-embedder' } };

    expect(installedModelTags(custom)).toEqual(['some-other-embedder']);
    // Generation runs remotely under every configuration, so no chat tag is ever this
    // install's to offer for removal.
    expect(
      installedModelTags({ ...custom, anthropic: { ...DEFAULTS.anthropic, apiKey: 'sk-test' } }),
    ).toEqual(['some-other-embedder']);
  });

  it('says what it cannot prove is ours when there is no manifest', () => {
    mkdirSync(join(dir, '.aion'), { recursive: true });

    const items = planUninstall({
      profile: 'native',
      dataDir: join(dir, '.aion'),
      manifest: undefined,
      launchAgentPath: join(dir, 'absent.plist'),
      platform: 'darwin',
      models: MODELS,
      settingsPath,
    });

    expect(items.find((item) => item.action === 'manual')?.why).toContain('not provably ours');
  });

  it('takes the volumes on the docker profile', () => {
    const items = planUninstall({
      profile: 'docker',
      dataDir: '/data',
      manifest: undefined,
      launchAgentPath: join(dir, 'absent.plist'),
      platform: 'darwin',
      models: MODELS,
      settingsPath,
    });

    const compose = items.find((item) => item.what === 'compose services and volumes');
    expect(compose).toMatchObject({ action: 'remove' });
    expect(compose?.commands?.join('\n')).toContain('docker volume rm');
  });
});

describe('the config lines', () => {
  it('cuts the lines this install wrote and leaves everything else verbatim', () => {
    const confFile = join(dir, 'neo4j.conf');
    const owned = NEO4J_SETTINGS.map(([key, value]) => `${key}=${value}`);
    writeFileSync(confFile, ['# somebody wrote this', ...owned, 'dbms.other=keep', ''].join('\n'));

    expect(stripOwnedSettings(confFile, NEO4J_SETTINGS)).toBe(owned.length);
    const left = readFileSync(confFile, 'utf8');
    expect(left).toContain('# somebody wrote this');
    expect(left).toContain('dbms.other=keep');
    for (const line of owned) {
      expect(left).not.toContain(line);
    }
  });

  it('leaves a key we own whose value somebody changed', () => {
    // An edited setting is a decision. Cutting it because the key matches would undo it silently.
    const confFile = join(dir, 'neo4j.conf');
    writeFileSync(confFile, 'server.memory.heap.max_size=8G\n');

    expect(stripOwnedSettings(confFile, NEO4J_SETTINGS)).toBe(0);
    expect(readFileSync(confFile, 'utf8')).toContain('8G');
  });
});

describe('executing it', () => {
  it('unloads the job before deleting it, and removes the data root', async () => {
    const dataDir = join(dir, '.aion');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'aion.sqlite'), 'substrate');
    const plist = join(dir, 'com.aion.mcp.plist');
    writeFileSync(plist, '<plist/>');
    const host = scripted();
    const items = planUninstall({
      profile: 'native',
      dataDir,
      manifest: manifest(),
      launchAgentPath: plist,
      platform: 'darwin',
      models: MODELS,
      settingsPath,
    });

    const execution = await executeUninstall(
      items,
      manifest(),
      host.actions,
      () => Promise.resolve(''),
      () => undefined,
    );

    expect(host.calls[0]?.startsWith('launchctl bootout gui/')).toBe(true);
    expect(existsSync(plist)).toBe(false);
    expect(existsSync(dataDir)).toBe(false);
    expect(execution.failed).toEqual([]);
    expect(execution.removed).toHaveLength(2);
  });

  it('carries on past a job that was never loaded', async () => {
    const dataDir = join(dir, '.aion');
    mkdirSync(dataDir, { recursive: true });
    const plist = join(dir, 'com.aion.mcp.plist');
    writeFileSync(plist, '<plist/>');
    const host = scripted({ ok: false, stdout: '', stderr: 'Boot-out failed: 3: No such process' });
    const said: string[] = [];

    const execution = await executeUninstall(
      planUninstall({
        profile: 'native',
        dataDir,
        manifest: manifest(),
        launchAgentPath: plist,
        platform: 'darwin',
        models: MODELS,
        settingsPath,
      }),
      manifest(),
      host.actions,
      () => Promise.resolve(''),
      (line) => said.push(line),
    );

    expect(said.join('\n')).toContain('was not loaded');
    expect(existsSync(plist)).toBe(false);
    expect(existsSync(dataDir)).toBe(false);
    expect(execution.failed).toEqual([]);
  });

  it('takes the volumes down through compose on the docker profile', async () => {
    const args: string[][] = [];

    await executeUninstall(
      planUninstall({
        profile: 'docker',
        dataDir: join(dir, 'absent'),
        manifest: undefined,
        launchAgentPath: join(dir, 'absent.plist'),
        platform: 'darwin',
        models: MODELS,
        settingsPath,
      }),
      undefined,
      scripted().actions,
      (called) => {
        args.push([...called]);
        return Promise.resolve('');
      },
      () => undefined,
    );

    expect(args).toEqual([['--profile', 'mcp', 'down', '--volumes']]);
  });
});

describe('the printed plan', () => {
  it('groups by what happens to each item and carries the commands', () => {
    const said: string[] = [];

    writePlan(
      [
        { what: 'data root', target: '/x/.aion', action: 'remove', why: 'the memory store' },
        {
          what: 'neo4j server',
          target: '/opt/neo4j',
          action: 'keep',
          why: 'shared',
          commands: ['brew uninstall neo4j'],
        },
      ],
      (line) => said.push(line),
    );

    expect(said[0]).toBe('remove:');
    expect(said.join('\n')).toContain('keep:');
    expect(said.join('\n')).toContain('$ brew uninstall neo4j');
  });
});

/**
 * The gap this closes: init installs the claude hooks through `installFullProfile`, but the old
 * plan named no step for them and the old executor had nothing but the recursive `rmSync`
 * fallback, which would have deleted the settings file outright rather than stripping the entries
 * this install owns. These run the real `installHooks`/`uninstallHooks` pair against a scratch
 * home, the way `hooks-cmd.test.ts` does, rather than asserting against the plan alone.
 */
describe('the claude hooks step', () => {
  const HOOKS_NOW = new Date('2026-09-13T00:00:00.000Z');
  let repoDir: string;

  beforeEach(() => {
    repoDir = join(dir, 'repo');
    mkdirSync(join(repoDir, 'packages', 'cli', 'dist'), { recursive: true });
    writeFileSync(
      join(repoDir, 'packages', 'cli', 'dist', 'hook-main.js'),
      '#!/usr/bin/env node\n',
    );
  });

  function hooksOptions(overrides: Partial<HooksCommandOptions> = {}): HooksCommandOptions {
    return {
      flags: { profile: 'full', withResearchCapture: true, stopMode: 'push', harness: 'claude' },
      settingsPath,
      codexHooksPath: join(dir, 'codex-hooks.json'),
      codexConfigPath: join(dir, 'codex-config.toml'),
      repo: { path: repoDir, verified: true },
      now: HOOKS_NOW,
      env: {},
      ...overrides,
    };
  }

  function plan(over: Partial<Parameters<typeof planUninstall>[0]> = {}) {
    return planUninstall({
      profile: 'native',
      dataDir: join(dir, 'never-made'),
      manifest: undefined,
      launchAgentPath: join(dir, 'absent.plist'),
      platform: 'darwin',
      models: MODELS,
      settingsPath,
      ...over,
    });
  }

  function run(items: ReturnType<typeof plan>) {
    return executeUninstall(
      items,
      undefined,
      scripted().actions,
      () => Promise.resolve(''),
      () => undefined,
      HOOKS_NOW,
    );
  }

  function settings(): Record<string, unknown> {
    return JSON.parse(readFileSync(settingsPath, 'utf8'));
  }

  it('names the step in the displayed plan, before the data root', () => {
    installHooks(hooksOptions(), () => undefined);
    const dataDir = join(dir, '.aion');
    mkdirSync(dataDir, { recursive: true });

    const items = plan({ dataDir });
    const said: string[] = [];
    writePlan(items, (line) => said.push(line));

    expect(items.filter((item) => item.action === 'remove').map((item) => item.what)).toEqual([
      'claude hooks',
      'data root',
    ]);
    expect(said.join('\n')).toContain(`claude hooks: ${settingsPath}`);
    expect(said.join('\n')).toContain('aion hook registrations');
  });

  it('lists the step on the docker profile too, since hooks are not profile-specific', () => {
    installHooks(hooksOptions(), () => undefined);

    const items = plan({ profile: 'docker', dataDir: join(dir, 'absent') });

    expect(items.find((item) => item.what === 'claude hooks')).toMatchObject({ action: 'remove' });
  });

  it('removes exactly what init installed, round tripped through the real helpers', async () => {
    installHooks(hooksOptions(), () => undefined);
    expect(describeAionHooks(settings())).not.toHaveLength(0);

    const execution = await run(plan());

    expect(execution.failed).toEqual([]);
    expect(describeAionHooks(settings())).toEqual([]);
  });

  it('preserves other hooks, mixed matcher entries, permissions, and unrelated settings', async () => {
    mkdirSync(dirname(settingsPath), { recursive: true });
    const original = {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'notify-send done' }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'lint-staged' }] }],
      },
      permissions: { allow: ['Bash(npm test)'] },
      model: 'opus',
    };
    writeFileSync(settingsPath, JSON.stringify(original));
    installHooks(hooksOptions(), () => undefined);

    await run(plan());

    const left = settings();
    expect(left.model).toBe('opus');
    expect(left.permissions).toEqual(original.permissions);
    const hooks = left.hooks as { Stop: unknown; PreToolUse: unknown };
    expect(hooks.Stop).toEqual(original.hooks.Stop);
    expect(hooks.PreToolUse).toEqual(original.hooks.PreToolUse);
    expect(describeAionHooks(left)).toEqual([]);
  });

  it('is idempotent: a second uninstall finds nothing left to remove', async () => {
    installHooks(hooksOptions(), () => undefined);

    await run(plan());
    const second = plan();

    expect(second.find((item) => item.what === 'claude hooks')).toBeUndefined();
    const execution = await run(second);
    expect(execution).toEqual({ removed: [], failed: [] });
    expect(describeAionHooks(settings())).toEqual([]);
  });

  it('leaves an unreadable settings file unchanged and reports a failed step', async () => {
    // A directory at the settings path is unreadable as a file (EISDIR), the same forcing
    // hooks-cmd.test.ts uses for the same failure.
    mkdirSync(settingsPath, { recursive: true });

    const items = plan();
    expect(items.find((item) => item.what === 'claude hooks')).toMatchObject({ action: 'remove' });

    const execution = await run(items);

    expect(execution.removed).toEqual([]);
    expect(execution.failed).toHaveLength(1);
    expect(execution.failed[0]).toContain('claude hooks');
    expect(existsSync(settingsPath)).toBe(true);
  });

  it('removes the hooks before the data root, in both plan and execution order', async () => {
    installHooks(hooksOptions(), () => undefined);
    const dataDir = join(dir, '.aion');
    mkdirSync(dataDir, { recursive: true });

    const items = plan({ dataDir });
    expect(items.findIndex((item) => item.what === 'claude hooks')).toBeLessThan(
      items.findIndex((item) => item.what === 'data root'),
    );

    const execution = await run(items);

    const hooksIndex = execution.removed.findIndex((line) => line.startsWith('claude hooks'));
    const dataRootIndex = execution.removed.findIndex((line) => line.startsWith('data root'));
    expect(hooksIndex).toBeGreaterThanOrEqual(0);
    expect(dataRootIndex).toBeGreaterThan(hooksIndex);
  });
});
