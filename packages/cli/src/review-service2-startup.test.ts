import { DEFAULTS, SqliteStore } from '@aion/core';
import { beginSubstratePairing } from '@aion/core/infrastructure/sqlite/publication-control.js';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { HostActions } from './host-actions.js';
import { launchAgentPath } from './launchd.js';
import { prepareNativeService } from './native-install.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-service2-start-'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

async function start(build: string, alreadyRunning = false) {
  vi.stubEnv('AION_BUILD_SHA', build);
  const path = join(dir, 'aion.sqlite');
  const store = new SqliteStore({ filePath: path });
  const id = beginSubstratePairing(store.db, 1).substrateId;
  store.close();
  const repoDir = join(dir, 'repo');
  mkdirSync(join(repoDir, 'packages', 'mcp', 'dist'), { recursive: true });
  writeFileSync(join(repoDir, 'packages', 'mcp', 'dist', 'main.js'), '');
  writeFileSync(join(repoDir, '.env'), '');
  const calls: string[] = [];
  let booted = false;
  const originalPid = alreadyRunning ? '6316' : undefined;
  const actions: HostActions = {
    run: async (program, args) => {
      calls.push([program, ...args].join(' '));
      if (program === 'lsof') {
        const pid = booted ? '7001' : originalPid;
        return { ok: pid !== undefined, stdout: pid ?? '', stderr: '' };
      }
      if (program === 'launchctl' && args[0] === 'print') {
        const pid = booted ? '7001' : originalPid;
        return pid === undefined
          ? { ok: false, stdout: '', stderr: 'Could not find service' }
          : { ok: true, stdout: `pid = ${pid}`, stderr: '' };
      }
      if (program === 'launchctl' && args[0] === 'bootstrap') {
        booted = true;
      }
      return { ok: true, stdout: '', stderr: '' };
    },
    fetch: async () => {
      throw new Error('no download');
    },
  };
  let error: unknown;
  try {
    await prepareNativeService(
      {
        ...DEFAULTS,
        sqlite: { ...DEFAULTS.sqlite, path },
        logging: { ...DEFAULTS.logging, filePath: join(dir, 'log') },
      },
      repoDir,
      () => undefined,
      {
        home: dir,
        actions,
        waitFor: async () => undefined,
        readHealth: async () =>
          booted ? { status: 'ok', build_sha: build || 'unstamped', store_id: id } : undefined,
      },
    );
  } catch (caught) {
    error = caught;
  }
  console.log(
    JSON.stringify({
      build,
      alreadyRunning,
      calls,
      error: String(error),
      plist: existsSync(launchAgentPath(dir)),
    }),
  );
  return { error, calls };
}

it('does not restart an owned silent service when the intended build cannot be identified', async () => {
  const result = await start('', true);
  expect(result.error).toBeDefined();
  expect.soft(result.calls.some((call) => /bootout|bootstrap/.test(call))).toBe(false);
  expect(existsSync(launchAgentPath(dir))).toBe(false);
});

it('boots and verifies a cold service when the intended build is identified', async () => {
  const result = await start('abc1234');
  expect(result.error).toBeUndefined();
  expect(result.calls.filter((call) => call.includes('bootstrap'))).toHaveLength(1);
});
