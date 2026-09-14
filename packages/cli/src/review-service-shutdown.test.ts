import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

import type { HostActions } from './host-actions.js';
import type { InstallManifest } from './install-manifest.js';
import { executeUninstall } from './uninstall.js';
import { planUninstall } from './uninstall-plan.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-service-review-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

type Mode = 'missing-plist' | 'reader-errors' | 'still-loaded' | 'reader-throws' | 'stopped';
async function exercise(mode: Mode) {
  const dataDir = join(dir, 'data');
  const plist = join(dir, 'job.plist');
  mkdirSync(dataDir);
  writeFileSync(join(dataDir, 'keep'), 'accepted data');
  if (mode !== 'missing-plist') {
    writeFileSync(plist, 'job');
  }
  const manifest: InstallManifest = {
    version: 1,
    profile: 'native',
    recordedAt: '2026-09-14T00:00:00Z',
    repoDir: join(dir, 'repo'),
    dataDir,
    launchdPlist: plist,
  };
  const script = join(manifest.repoDir, 'packages', 'mcp', 'dist', 'main.js');
  const calls: string[] = [];
  let prints = 0;
  const actions: HostActions = {
    run: async (program, args) => {
      calls.push([program, ...args].join(' '));
      if (mode === 'reader-throws' && program === 'launchctl' && args[0] === 'print') {
        throw new Error('observation failed');
      }
      if (program === 'launchctl' && args[0] === 'print') {
        prints += 1;
        if (prints === 1 || mode === 'missing-plist') {
          return { ok: true, stdout: 'state = running\npid = 6316\n', stderr: '' };
        }
        if (mode === 'still-loaded') {
          return { ok: true, stdout: 'state = waiting\nruns = 1\n', stderr: '' };
        }
        if (mode === 'reader-errors') {
          return { ok: false, stdout: '', stderr: 'print: permission denied' };
        }
        return { ok: false, stdout: '', stderr: 'Could not find service "com.aion.mcp"' };
      }
      if (program === 'ps') {
        if (mode === 'reader-errors') {
          return { ok: false, stdout: '', stderr: 'spawn ps ENOENT' };
        }
        return { ok: true, stdout: mode === 'missing-plist' ? `node ${script}` : '', stderr: '' };
      }
      if (program === 'lsof') {
        if (mode === 'reader-errors') {
          return { ok: false, stdout: '', stderr: 'spawn lsof ENOENT' };
        }
        return { ok: true, stdout: mode === 'missing-plist' ? '6316' : '', stderr: '' };
      }
      return {
        ok: mode === 'stopped',
        stdout: '',
        stderr: mode === 'stopped' ? '' : 'bootout failed',
      };
    },
    fetch: async () => {
      throw new Error('no download');
    },
  };
  const plan = planUninstall({
    profile: 'native',
    dataDir,
    manifest,
    launchAgentPath: plist,
    platform: 'darwin',
    models: [],
    settingsPath: join(dir, 'absent-settings'),
  });
  const result = await executeUninstall(
    plan,
    manifest,
    actions,
    async () => '',
    () => undefined,
    new Date(),
    8765,
  );
  console.log(
    JSON.stringify({
      mode,
      result,
      calls,
      dataExists: existsSync(dataDir),
      plistExists: existsSync(plist),
    }),
  );
  return { result, dataDir, plist, calls };
}

it.each(['missing-plist', 'reader-errors', 'still-loaded', 'reader-throws'] as const)(
  'keeps the store when shutdown is not established: %s',
  async (mode) => {
    const state = await exercise(mode);
    expect.soft(existsSync(state.dataDir)).toBe(true);
    expect(state.result.failed.length).toBeGreaterThan(0);
    if (mode !== 'missing-plist') {
      expect(existsSync(state.plist)).toBe(true);
    }
  },
);

it('still removes the owned files after a proved successful stop', async () => {
  const state = await exercise('stopped');
  expect(state.result.failed).toEqual([]);
  expect(existsSync(state.dataDir)).toBe(false);
  expect(existsSync(state.plist)).toBe(false);
});
