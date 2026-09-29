import { DEFAULTS, SqliteStore } from '@aion/core';
import { beginSubstratePairing } from '@aion/core/infrastructure/sqlite/publication-control.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NativeSetupError, type HostActions, type HostResult } from './host-actions.js';
import { launchAgentPath, MCP_LAUNCH_LABEL } from './launchd.js';
import { prepareNativeService, serviceEnvironment } from './native-install.js';

/**
 * The MCP half of the native install, with launchd, the port readers and the probe behind seams.
 * Nothing here loads a job, runs launchctl, or talks to a server; the stores are real files in a
 * temporary directory, because the identity the install checks is the store's own.
 */

/** The sha the wrapper exports on a run whose build holds HEAD, which is what the job carries. */
const BUILD_SHA = 'abc1234';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-native-service-'));
  // A service can only be matched against a build this install can name, so every fixture that
  // reaches the binding check carries the stamp a real native run has.
  vi.stubEnv('AION_BUILD_SHA', BUILD_SHA);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Every host command answers the same way, except the port read: `lsof` with nothing to list
 * exits zero with no output, and a test about launchctl must not also be a test about a port that
 * could not be seen.
 */
function scripted(result: HostResult): { actions: HostActions; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    actions: {
      run: (program, args) => {
        calls.push([program, ...args].join(' '));
        if (program === 'lsof') {
          return Promise.resolve({ ok: true, stdout: '', stderr: '' });
        }
        return Promise.resolve(result);
      },
      fetch: () => Promise.reject(new Error('no fetch in this path')),
    },
  };
}

/** `/health` from nothing at all: the port is silent and the seam says so without a request. */
const silent = () => Promise.resolve(undefined);

/** A machine as the commands the install runs would describe it. */
type Machine = {
  readonly loaded?: boolean;
  /** The pid launchd names for the job. */
  readonly jobPid?: number;
  /** The pids holding the mcp port. */
  readonly listeners?: readonly number[];
};

function machineActions(machine: Machine): { actions: HostActions; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    actions: {
      run: (program, args) => {
        calls.push([program, ...args].join(' '));
        if (program === 'launchctl' && args[0] === 'print') {
          if (machine.loaded === false) {
            return Promise.resolve({ ok: false, stdout: '', stderr: 'Could not find service' });
          }
          const pid = machine.jobPid;
          return Promise.resolve({
            ok: true,
            stdout: pid === undefined ? '\tstate = running\n' : `\tpid = ${String(pid)}\n`,
            stderr: '',
          });
        }
        if (program === 'lsof') {
          return Promise.resolve({
            ok: true,
            stdout: (machine.listeners ?? []).map(String).join('\n'),
            stderr: '',
          });
        }
        return Promise.resolve({ ok: true, stdout: '', stderr: '' });
      },
      fetch: () => Promise.reject(new Error('no fetch in this path')),
    },
  };
}

/** A real store on disk carrying a pairing row, which is what a served substrate looks like. */
function pairedStore(name: string): { path: string; id: string } {
  const path = join(dir, name);
  const store = new SqliteStore({ filePath: path });
  try {
    return { path, id: beginSubstratePairing(store.db, 1).substrateId };
  } finally {
    store.close();
  }
}

/** The old-handle/new-file case: the same pathname, a different store behind it. */
function replaceStoreAt(path: string): string {
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${path}${suffix}`, { force: true });
  }
  const store = new SqliteStore({ filePath: path });
  try {
    return beginSubstratePairing(store.db, 1).substrateId;
  } finally {
    store.close();
  }
}

/** `/health` as the running service would answer it, scripted per call. */
function probing(...bodies: readonly (Record<string, unknown> | undefined)[]) {
  const answers = [...bodies];
  return () => Promise.resolve(answers.length > 1 ? answers.shift() : answers[0]);
}

function healthy(storeId: string, buildSha = BUILD_SHA): Record<string, unknown> {
  return { status: 'ok', build_sha: buildSha, store_id: storeId };
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
    sqlite: { ...DEFAULTS.sqlite, path: join(dir, 'aion.sqlite') },
    ...over,
  };
}

/** The store at the configured path, which is the one the service has to be holding. */
function storedAt(store: { path: string }) {
  return { sqlite: { ...DEFAULTS.sqlite, path: store.path } };
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
    const store = pairedStore('aion.sqlite');
    const host = machineActions({ jobPid: 6316, listeners: [6316] });
    const said: string[] = [];
    const waited: number[] = [];

    await prepareNativeService(config(storedAt(store)), repoDir, (line) => said.push(line), {
      actions: host.actions,
      home: dir,
      waitFor: (port) => {
        waited.push(port);
        return Promise.resolve();
      },
      readHealth: probing(healthy(store.id)),
    });

    const plistPath = launchAgentPath(dir);
    expect(existsSync(plistPath)).toBe(true);
    expect(readFileSync(plistPath, 'utf8')).toContain(MCP_LAUNCH_LABEL);
    // Unload then load: launchd reads the plist at load, so a rewritten file reaches a loaded job
    // no other way.
    const launchctl = host.calls.filter((call) => call.startsWith('launchctl'));
    const bootout = launchctl.findIndex((call) => call.startsWith('launchctl bootout gui/'));
    expect(bootout).toBeGreaterThanOrEqual(0);
    expect(launchctl[bootout + 1]?.startsWith('launchctl bootstrap gui/')).toBe(true);
    expect(waited).toContain(DEFAULTS.operational.mcpPort);
    expect(said.join('\n')).toContain('aion-mcp healthy');
    expect(said.join('\n')).toContain(store.id);
  });

  it('leaves a running service alone when the job, the build and the store all match', async () => {
    const repoDir = repo();
    const store = pairedStore('aion.sqlite');
    const machine = { jobPid: 6316, listeners: [6316] };
    const first = machineActions(machine);
    const seams = {
      actions: first.actions,
      home: dir,
      waitFor: () => Promise.resolve(),
      readHealth: probing(healthy(store.id)),
    };
    await prepareNativeService(config(storedAt(store)), repoDir, () => undefined, seams);

    const second = machineActions(machine);
    const said: string[] = [];
    await prepareNativeService(config(storedAt(store)), repoDir, (line) => said.push(line), {
      ...seams,
      actions: second.actions,
    });

    // The idempotent path: a re-run of init on a correctly bound install bounces nothing.
    expect(second.calls.some((call) => call.includes('bootout'))).toBe(false);
    expect(second.calls.some((call) => call.includes('bootstrap'))).toBe(false);
    expect(said.join('\n')).toContain('already running');
    expect(said.join('\n')).not.toContain('replacing');
  });

  it('reloads when the job changed, even though the server is answering', async () => {
    const repoDir = repo();
    const store = pairedStore('aion.sqlite');
    const host = machineActions({ jobPid: 6316, listeners: [6316] });
    const seams = {
      actions: host.actions,
      home: dir,
      waitFor: () => Promise.resolve(),
      readHealth: probing(healthy(store.id)),
    };
    await prepareNativeService(config(storedAt(store)), repoDir, () => undefined, seams);
    host.calls.length = 0;
    // What an edited `.env` looks like from here: the rendered job no longer matches the file.
    writeFileSync(join(repoDir, '.env'), 'AION_NEO4J_URI=bolt://127.0.0.1:7688\n');

    await prepareNativeService(config(storedAt(store)), repoDir, () => undefined, seams);

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
      readHealth: silent,
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
        readHealth: silent,
      }),
    ).rejects.toThrow('Load failed');
  });
});

/**
 * The live failure this exists for: a process whose store file was deleted out from under it kept
 * the handle, kept the port and kept answering `/health`, and a later init read matching plist
 * text plus that answer as "already running" while the store at the configured path went unserved
 * for three hours.
 */
describe('the service on the port has to be the intended one', () => {
  /** A first run, so the plist on disk is the one the second run would write. */
  async function installed(repoDir: string, store: { path: string; id: string }): Promise<void> {
    const host = machineActions({ jobPid: 6316, listeners: [6316] });
    await prepareNativeService(config(storedAt(store)), repoDir, () => undefined, {
      actions: host.actions,
      home: dir,
      waitFor: () => Promise.resolve(),
      readHealth: probing(healthy(store.id)),
    });
  }

  it('replaces a service holding a store the pathname no longer names', async () => {
    const repoDir = repo();
    const held = pairedStore('aion.sqlite');
    await installed(repoDir, held);
    // The same pathname, a different store behind it. The service still holds the old file.
    const current = replaceStoreAt(held.path);
    const host = machineActions({ jobPid: 6316, listeners: [6316] });
    const said: string[] = [];

    await prepareNativeService(config(storedAt(held)), repoDir, (line) => said.push(line), {
      actions: host.actions,
      home: dir,
      waitFor: () => Promise.resolve(),
      // The old handle first, then the process launchd started on the store now at the path.
      readHealth: probing(healthy(held.id), healthy(current)),
    });

    expect(said.join('\n')).toContain('replacing the service');
    expect(said.join('\n')).toContain(held.id);
    expect(host.calls.some((call) => call.includes('bootout'))).toBe(true);
    expect(host.calls.some((call) => call.includes('bootstrap'))).toBe(true);
    // Readiness came from the new process on the intended store, not from the old listener.
    expect(said.join('\n')).toContain(`store ${current}`);
  });

  it('refuses to report ready when the replacement comes up on the old store', async () => {
    const repoDir = repo();
    const held = pairedStore('aion.sqlite');
    const current = replaceStoreAt(held.path);
    const host = machineActions({ jobPid: 6316, listeners: [6316] });

    const failure = prepareNativeService(config(storedAt(held)), repoDir, () => undefined, {
      actions: host.actions,
      home: dir,
      waitFor: () => Promise.resolve(),
      // The listener answers with the old handle's store through the reload as well.
      readHealth: probing(healthy(held.id)),
    });

    await expect(failure).rejects.toThrow(NativeSetupError);
    await expect(failure).rejects.toThrow(held.path);
    await expect(failure).rejects.toThrow(held.id);
    await expect(failure).rejects.toThrow(current);
  });

  it('refuses to report ready when an old listener survived the reload', async () => {
    const repoDir = repo();
    const store = pairedStore('aion.sqlite');
    // launchd started a new process and the port is still held by the one it replaced.
    const host = machineActions({ jobPid: 7001, listeners: [6316] });

    const failure = prepareNativeService(config(storedAt(store)), repoDir, () => undefined, {
      actions: host.actions,
      home: dir,
      waitFor: () => Promise.resolve(),
      readHealth: probing(healthy(store.id)),
    });

    await expect(failure).rejects.toThrow('6316');
    await expect(failure).rejects.toThrow('7001');
    // Reported, never stopped: launchd owns our job and nothing here owns that process.
    expect(host.calls.join('\n')).not.toMatch(/\b(kill|pkill|killall)\b/);
  });

  it('reports rather than replaces a port this job does not own', async () => {
    const repoDir = repo();
    const store = pairedStore('aion.sqlite');
    await installed(repoDir, store);
    const host = machineActions({ loaded: false, listeners: [4242] });

    const failure = prepareNativeService(config(storedAt(store)), repoDir, () => undefined, {
      actions: host.actions,
      home: dir,
      waitFor: () => Promise.resolve(),
      readHealth: probing(healthy(store.id)),
    });

    await expect(failure).rejects.toThrow(`not ${MCP_LAUNCH_LABEL}`);
    expect(host.calls.some((call) => call.includes('bootout'))).toBe(false);
    expect(host.calls.some((call) => call.includes('bootstrap'))).toBe(false);
  });

  it('refuses to report ready when the service runs a build this install did not stamp', async () => {
    const repoDir = repo();
    const store = pairedStore('aion.sqlite');
    const host = machineActions({ jobPid: 6316, listeners: [6316] });

    const failure = prepareNativeService(config(storedAt(store)), repoDir, () => undefined, {
      actions: host.actions,
      home: dir,
      waitFor: () => Promise.resolve(),
      readHealth: probing(healthy(store.id, 'deadbee')),
    });

    await expect(failure).rejects.toThrow('deadbee');
  });

  /**
   * The ordering the refusal is worth nothing without. A changed plist used to skip the check
   * entirely: init rewrote the job file and issued bootout/bootstrap, then read the port and
   * refused. The refusal arrived after the machine had already been changed.
   */
  it('changes nothing before refusing a foreign listener under a plist that differs', async () => {
    const repoDir = repo();
    const store = pairedStore('aion.sqlite');
    const plistPath = launchAgentPath(dir);
    mkdirSync(dirname(plistPath), { recursive: true });
    writeFileSync(plistPath, 'a job this run did not write');
    const host = machineActions({ loaded: false, listeners: [4242] });

    const failure = prepareNativeService(config(storedAt(store)), repoDir, () => undefined, {
      actions: host.actions,
      home: dir,
      waitFor: () => Promise.resolve(),
      readHealth: probing(healthy(store.id)),
    });

    await expect(failure).rejects.toThrow(NativeSetupError);
    expect(host.calls.some((call) => /bootout|bootstrap/.test(call))).toBe(false);
    expect(readFileSync(plistPath, 'utf8')).toBe('a job this run did not write');
  });

  /** The same ordering when nothing answers: a silent port can still be somebody else's. */
  it('changes nothing when the port is held by a process that never answers', async () => {
    const repoDir = repo();
    const store = pairedStore('aion.sqlite');
    const host = machineActions({ loaded: false, listeners: [4242] });

    const failure = prepareNativeService(config(storedAt(store)), repoDir, () => undefined, {
      actions: host.actions,
      home: dir,
      waitFor: () => Promise.resolve(),
      readHealth: silent,
    });

    await expect(failure).rejects.toThrow('4242');
    expect(host.calls.some((call) => /bootout|bootstrap/.test(call))).toBe(false);
    expect(existsSync(launchAgentPath(dir))).toBe(false);
  });

  /** An unreadable port is not an empty one, and a job is not written over what cannot be seen. */
  it('refuses to write the job when the port could not be read', async () => {
    const repoDir = repo();
    const store = pairedStore('aion.sqlite');
    const blind = scripted({ ok: true, stdout: '', stderr: '' });
    const host: HostActions = {
      run: (program, args) =>
        program === 'lsof'
          ? Promise.resolve({ ok: false, stdout: '', stderr: 'spawn lsof ENOENT' })
          : blind.actions.run(program, args),
      fetch: () => Promise.reject(new Error('no fetch in this path')),
    };

    const failure = prepareNativeService(config(storedAt(store)), repoDir, () => undefined, {
      actions: host,
      home: dir,
      waitFor: () => Promise.resolve(),
      readHealth: silent,
    });

    await expect(failure).rejects.toThrow('could not be read');
    expect(existsSync(launchAgentPath(dir))).toBe(false);
  });

  it('refuses to report ready when the probe stops answering after the wait', async () => {
    const repoDir = repo();
    const store = pairedStore('aion.sqlite');
    const host = machineActions({ jobPid: 6316, listeners: [6316] });

    const failure = prepareNativeService(config(storedAt(store)), repoDir, () => undefined, {
      actions: host.actions,
      home: dir,
      waitFor: () => Promise.resolve(),
      readHealth: probing(undefined),
    });

    await expect(failure).rejects.toThrow('stopped answering');
  });
});
