import { DEFAULTS } from '@aion/core';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

/** What a plain local install pulled, which is what the plan is told rather than asked to guess. */
const MODELS = [DEFAULTS.models.cue, DEFAULTS.models.reflect, DEFAULTS.models.embed];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-uninstall-'));
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
    });

    const server = items.find((item) => item.what === 'neo4j server');
    expect(server?.commands?.join('\n')).toContain('ollama rm qwen3:14b snowflake-arctic-embed2');
    expect(server?.commands?.join('\n')).not.toContain('qwen3:1.7b');
  });

  it('reads them off config the way init does, so a remote role names no local tag', () => {
    const local = { ...DEFAULTS, models: { ...DEFAULTS.models, reflect: 'qwen3:14b' } };

    expect(installedModelTags(local)).toEqual([
      DEFAULTS.models.cue,
      'qwen3:14b',
      DEFAULTS.models.embed,
    ]);
    // A keyed install pulled no chat model at all: naming one would offer to remove a tag this
    // install never put on the machine.
    expect(
      installedModelTags({ ...local, anthropic: { ...DEFAULTS.anthropic, apiKey: 'sk-test' } }),
    ).toEqual([DEFAULTS.models.embed]);
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
