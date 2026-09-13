import { DEFAULTS } from '@aion/core';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NativeSetupError, type HostActions, type HostResult } from './host-actions.js';
import { launchAgentPath, MCP_LAUNCH_LABEL, MCP_SCRIPT_RELATIVE } from './launchd.js';
import { prepareNativeService, serviceEnvironment } from './native-install.js';

/**
 * The MCP half of the native install, with launchd and the readiness wait behind seams. Nothing
 * here loads a job or talks to a server.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-native-service-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function scripted(result: HostResult): { actions: HostActions; calls: string[] } {
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

/** The wrapper as text: it is bash, so what it promises is read rather than run. */
function nativeWrapper(): string {
  return readFileSync(fileURLToPath(new URL('../../../bin/aion-native', import.meta.url)), 'utf8');
}

function repo(): string {
  const repoDir = join(dir, 'repo');
  mkdirSync(join(repoDir, 'packages', 'mcp', 'dist'), { recursive: true });
  writeFileSync(join(repoDir, 'packages', 'mcp', 'dist', 'main.js'), '');
  writeFileSync(
    join(repoDir, '.env'),
    'AION_NEO4J_URI=bolt://127.0.0.1:7687\nAION_EMPTY=\nPATH=x\n',
  );
  return repoDir;
}

function config(over: Record<string, unknown> = {}) {
  return {
    ...DEFAULTS,
    install: { profile: 'native' as const },
    logging: { ...DEFAULTS.logging, filePath: join(dir, 'logs', 'aion.jsonl') },
    ...over,
  };
}

describe('the environment the job carries', () => {
  it('takes the AION_* values the install recorded, and nothing else in the file', () => {
    const repoDir = repo();

    const pairs = serviceEnvironment(join(repoDir, '.env'), {});

    expect(pairs).toEqual([['AION_NEO4J_URI', 'bolt://127.0.0.1:7687']]);
  });

  it('adds the build sha the wrapper computed, which is how doctor spots a stale service', () => {
    const repoDir = repo();

    const pairs = serviceEnvironment(join(repoDir, '.env'), { AION_BUILD_SHA: 'abc1234' });

    expect(pairs).toContainEqual(['AION_BUILD_SHA', 'abc1234']);
  });

  it('answers with the build sha alone when there is no .env yet', () => {
    expect(serviceEnvironment(join(dir, 'absent', '.env'), { AION_BUILD_SHA: 'abc1234' })).toEqual([
      ['AION_BUILD_SHA', 'abc1234'],
    ]);
  });

  /**
   * The sha has to be in the environment for any of the above to stamp anything, and on this
   * profile the wrapper is the only thing that computes one: no image is built, so nothing bakes
   * it in. Without this export every native job carries no sha and `doctor` reads `unstamped`
   * forever, which is the one thing the freshness check cannot recover from on its own.
   */
  it('is exported by the wrapper that starts a native run', () => {
    expect(nativeWrapper()).toContain('AION_BUILD_SHA="$AION_REPO_HEAD_SHA"');
    expect(nativeWrapper()).toMatch(/\bexport .*\bAION_BUILD_SHA\b/);
  });

  /**
   * And exported only when HEAD is what was built. `npm run build` is a separate step here, where
   * the docker wrapper rebuilds its image on the way past, so a pull with no build would stamp
   * the job with a sha the running code does not hold and `doctor` would read a stale service as
   * fresh — a wrong answer, where the unstamped one was only a useless one.
   */
  it('stamps HEAD only when the build is not older than the tracked sources', () => {
    const wrapper = nativeWrapper();

    expect(wrapper).toMatch(/if build_holds_head; then\n\s*AION_BUILD_SHA="\$AION_REPO_HEAD_SHA"/);
    expect(wrapper).toContain('ls-files');
    expect(wrapper).toContain(MCP_SCRIPT_RELATIVE);
  });
});

describe('preparing the service', () => {
  it('refuses before it writes anything when the server is not built', async () => {
    const repoDir = join(dir, 'unbuilt');
    mkdirSync(repoDir, { recursive: true });
    const host = scripted({ ok: true, stdout: '', stderr: '' });

    await expect(
      prepareNativeService(config(), repoDir, () => undefined, {
        actions: host.actions,
        home: dir,
        waitFor: () => Promise.resolve(),
      }),
    ).rejects.toThrow(NativeSetupError);
    expect(host.calls).toEqual([]);
    expect(existsSync(launchAgentPath(dir))).toBe(false);
  });

  it('writes the job, loads it, and waits for the server to answer', async () => {
    const repoDir = repo();
    const host = scripted({ ok: true, stdout: '', stderr: '' });
    const said: string[] = [];
    const waited: number[] = [];

    await prepareNativeService(config(), repoDir, (line) => said.push(line), {
      actions: host.actions,
      home: dir,
      waitFor: (port) => {
        waited.push(port);
        return Promise.resolve();
      },
    });

    const plistPath = launchAgentPath(dir);
    expect(existsSync(plistPath)).toBe(true);
    expect(readFileSync(plistPath, 'utf8')).toContain(MCP_LAUNCH_LABEL);
    // Unload then load: launchd reads the plist at load, so a rewritten file reaches a loaded job
    // no other way.
    expect(host.calls[0]?.startsWith('launchctl bootout gui/')).toBe(true);
    expect(host.calls[1]?.startsWith('launchctl bootstrap gui/')).toBe(true);
    expect(waited).toContain(DEFAULTS.operational.mcpPort);
    expect(said.join('\n')).toContain('aion-mcp healthy');
  });

  it('leaves a running service alone when the job it would write is the one on disk', async () => {
    const repoDir = repo();
    const first = scripted({ ok: true, stdout: '', stderr: '' });
    const seams = { actions: first.actions, home: dir, waitFor: () => Promise.resolve() };
    await prepareNativeService(config(), repoDir, () => undefined, seams);

    const second = scripted({ ok: true, stdout: '', stderr: '' });
    const said: string[] = [];
    await prepareNativeService(config(), repoDir, (line) => said.push(line), {
      ...seams,
      actions: second.actions,
    });

    // The idempotent path: a re-run of init on a healthy install bounces nothing.
    expect(second.calls).toEqual([]);
    expect(said.join('\n')).toContain('already running');
  });

  it('reloads when the job changed, even though the server is answering', async () => {
    const repoDir = repo();
    const host = scripted({ ok: true, stdout: '', stderr: '' });
    const seams = { actions: host.actions, home: dir, waitFor: () => Promise.resolve() };
    await prepareNativeService(config(), repoDir, () => undefined, seams);
    host.calls.length = 0;
    // What an edited `.env` looks like from here: the rendered job no longer matches the file.
    writeFileSync(join(repoDir, '.env'), 'AION_NEO4J_URI=bolt://127.0.0.1:7688\n');

    await prepareNativeService(config(), repoDir, () => undefined, seams);

    expect(host.calls.some((call) => call.includes('bootstrap'))).toBe(true);
    expect(readFileSync(launchAgentPath(dir), 'utf8')).toContain('7688');
  });

  it('names the logs and the launchctl read when the loaded job never answers', async () => {
    const repoDir = repo();
    const host = scripted({ ok: true, stdout: '', stderr: '' });

    const failure = prepareNativeService(config(), repoDir, () => undefined, {
      actions: host.actions,
      home: dir,
      waitFor: () => Promise.reject(new Error('timed out')),
    });

    await expect(failure).rejects.toThrow('did not answer on port');
    await expect(failure).rejects.toThrow('launchctl print');
  });

  it('names what launchctl said when the load itself failed', async () => {
    const repoDir = repo();
    const host = scripted({ ok: false, stdout: '', stderr: 'Load failed: 5: Input/output error' });

    await expect(
      prepareNativeService(config(), repoDir, () => undefined, {
        actions: host.actions,
        home: dir,
        waitFor: () => Promise.resolve(),
      }),
    ).rejects.toThrow('Load failed');
  });
});
