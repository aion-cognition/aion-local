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
  dir = mkdtempSync(join(tmpdir(), 'aion-service2-review-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

type Mode =
  | 'success-loaded'
  | 'success-unreadable-after'
  | 'missing-plist-loaded'
  | 'unreadable-before'
  | 'stopped';
async function exercise(mode: Mode) {
  const dataDir = join(dir, 'data');
  const plist = join(dir, 'job.plist');
  mkdirSync(dataDir);
  writeFileSync(join(dataDir, 'keep'), 'accepted data');
  if (mode !== 'missing-plist-loaded') {
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
  const calls: string[] = [];
  let prints = 0;
  const actions: HostActions = {
    run: async (program, args) => {
      calls.push([program, ...args].join(' '));
      if (program === 'launchctl' && args[0] === 'print') {
        prints += 1;
        if (mode === 'missing-plist-loaded' || (prints > 1 && mode === 'success-loaded')) {
          return { ok: true, stdout: 'state = waiting\nruns = 1\n', stderr: '' };
        }
        if (
          (prints === 1 && mode === 'unreadable-before') ||
          (prints > 1 && mode === 'success-unreadable-after')
        ) {
          return { ok: false, stdout: '', stderr: 'launchctl print: permission denied' };
        }
        if (prints === 1) {
          return { ok: true, stdout: 'pid = 6316\nstate = running\n', stderr: '' };
        }
        return { ok: false, stdout: '', stderr: 'Could not find service "com.aion.mcp"' };
      }
      if (program === 'launchctl' && args[0] === 'bootout') {
        return {
          ok: mode !== 'unreadable-before',
          stdout: '',
          stderr: mode === 'unreadable-before' ? 'bootout failed' : '',
        };
      }
      return { ok: false, stdout: '', stderr: '' };
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
  return { result, dataDir, plist };
}

it.each([
  'success-loaded',
  'success-unreadable-after',
  'missing-plist-loaded',
  'unreadable-before',
] as const)(
  'retains the store until every shutdown observation is sufficient: %s',
  async (mode) => {
    const state = await exercise(mode);
    expect.soft(existsSync(state.dataDir)).toBe(true);
    expect(state.result.failed.length).toBeGreaterThan(0);
  },
);

it('still deletes after the known process exited and launchd no longer holds the job', async () => {
  const state = await exercise('stopped');
  expect(state.result.failed).toEqual([]);
  expect(existsSync(state.dataDir)).toBe(false);
  expect(existsSync(state.plist)).toBe(false);
});
