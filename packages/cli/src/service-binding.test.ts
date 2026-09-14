import { SqliteStore } from '@aion/core';
import { beginSubstratePairing } from '@aion/core/infrastructure/sqlite/publication-control.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { HostActions } from './host-actions.js';
import { MCP_LAUNCH_LABEL } from './launchd.js';
import {
  observeStoreIdentity,
  readLaunchdJob,
  readListenerPids,
  readProcessCommand,
  readStoreIdentity,
  verifyServiceBinding,
  type IntendedService,
} from './service-binding.js';

/**
 * The identity check, against temporary stores and scripted host commands. Nothing here runs
 * launchctl, lsof or ps, opens a port, or talks to a service.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-binding-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A machine, as the four commands this module runs would describe it. */
type Machine = {
  /** Whether launchctl still knows the label. */
  readonly loaded?: boolean;
  /** The pid launchd names for the job, absent when it names none. */
  readonly jobPid?: number;
  /** The pids holding the port. */
  readonly listeners?: readonly number[];
  /** Live processes, by pid, and what each is running. */
  readonly processes?: Readonly<Record<number, string>>;
};

function machineActions(machine: Machine = {}): {
  actions: HostActions;
  calls: string[];
} {
  const calls: string[] = [];
  const processes = machine.processes ?? {};
  return {
    calls,
    actions: {
      run: (program, args) => {
        calls.push([program, ...args].join(' '));
        if (program === 'launchctl' && args[0] === 'print') {
          if (machine.loaded === false) {
            return Promise.resolve({
              ok: false,
              stdout: '',
              stderr: `Could not find service "${MCP_LAUNCH_LABEL}"`,
            });
          }
          const pid = machine.jobPid;
          return Promise.resolve({
            ok: true,
            stdout:
              pid === undefined
                ? '\tstate = not running\n'
                : `\tstate = running\n\tpid = ${String(pid)}\n\truns = 1\n`,
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
        if (program === 'ps') {
          const pid = Number.parseInt(args[1] ?? '', 10);
          return Promise.resolve({ ok: true, stdout: processes[pid] ?? '', stderr: '' });
        }
        return Promise.resolve({ ok: true, stdout: '', stderr: '' });
      },
      fetch: () => Promise.reject(new Error('no download belongs in this path')),
    },
  };
}

/** A real store on disk with a pairing row, which is what a served substrate carries. */
function pairedStore(name: string, root: string): { path: string; id: string } {
  const path = join(root, name);
  const store = new SqliteStore({ filePath: path });
  try {
    return { path, id: beginSubstratePairing(store.db, 1).substrateId };
  } finally {
    store.close();
  }
}

function intended(over: Partial<IntendedService> = {}): IntendedService {
  return { port: 8765, buildSha: 'abc1234', storePath: join(dir, 'aion.sqlite'), ...over };
}

function health(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { status: 'ok', build_sha: 'abc1234', ...over };
}

describe('reading the store identity off disk', () => {
  it('answers with the id the substrate minted', () => {
    const store = pairedStore('aion.sqlite', dir);

    expect(readStoreIdentity(store.path)).toBe(store.id);
  });

  it('answers with nothing for a path holding no store', () => {
    expect(readStoreIdentity(join(dir, 'never-made.sqlite'))).toBeUndefined();
  });

  it('answers with nothing for a store no service has paired', () => {
    const path = join(dir, 'unpaired.sqlite');
    new SqliteStore({ filePath: path }).close();

    expect(readStoreIdentity(path)).toBeUndefined();
  });
});

describe('what makes a healthy service this installation’s', () => {
  it('takes the listener, the build and the store together', async () => {
    const store = pairedStore('aion.sqlite', dir);
    const machine = machineActions({ jobPid: 6316, listeners: [6316] });

    const binding = await verifyServiceBinding(
      health({ store_id: store.id }),
      intended({ storePath: store.path }),
      machine.actions,
    );

    expect(binding).toEqual({ kind: 'bound', pid: 6316, buildSha: 'abc1234', storeId: store.id });
  });

  /**
   * The live failure: matching plist text plus a 200 on the port, from a process holding a file
   * that is no longer the one at the pathname. Same path, same port, same job, different store.
   */
  it('refuses a service holding a store the pathname no longer names', async () => {
    const current = pairedStore('aion.sqlite', dir);
    const replaced = pairedStore('old.sqlite', dir);
    const machine = machineActions({ jobPid: 6316, listeners: [6316] });

    const binding = await verifyServiceBinding(
      health({ store_id: replaced.id }),
      intended({ storePath: current.path }),
      machine.actions,
    );

    expect(binding.kind).toBe('stale');
    expect(binding.kind === 'stale' ? binding.reason : '').toContain(replaced.id);
    expect(binding.kind === 'stale' ? binding.reason : '').toContain(current.id);
  });

  it('refuses a service that reports no store at all', async () => {
    const store = pairedStore('aion.sqlite', dir);
    const machine = machineActions({ jobPid: 6316, listeners: [6316] });

    const binding = await verifyServiceBinding(
      health(),
      intended({ storePath: store.path }),
      machine.actions,
    );

    expect(binding).toEqual({
      kind: 'stale',
      reason: 'the service does not report which store it has open',
    });
  });

  it('refuses a service running a build this install did not stamp', async () => {
    const store = pairedStore('aion.sqlite', dir);
    const machine = machineActions({ jobPid: 6316, listeners: [6316] });

    const binding = await verifyServiceBinding(
      health({ build_sha: 'unstamped', store_id: store.id }),
      intended({ storePath: store.path }),
      machine.actions,
    );

    expect(binding.kind).toBe('stale');
    expect(binding.kind === 'stale' ? binding.reason : '').toContain('unstamped');
  });

  /**
   * Two absent stamps compare equal and prove nothing. Reported rather than replaced, because an
   * install that cannot stamp a build would replace the service, read the sentinel back, and
   * replace it again on every run.
   */
  it('refuses to certify code identity when this install carries no build stamp', async () => {
    const store = pairedStore('aion.sqlite', dir);
    const machine = machineActions({ jobPid: 6316, listeners: [6316] });

    const binding = await verifyServiceBinding(
      { status: 'ok', store_id: store.id },
      intended({ storePath: store.path, buildSha: 'unstamped' }),
      machine.actions,
    );

    expect(binding.kind).toBe('unverified');
  });

  it('refuses when the configured path carries no paired store', async () => {
    const machine = machineActions({ jobPid: 6316, listeners: [6316] });

    const binding = await verifyServiceBinding(
      health({ store_id: 'a-store-somewhere-else' }),
      intended({ storePath: join(dir, 'never-made.sqlite') }),
      machine.actions,
    );

    expect(binding.kind).toBe('stale');
  });
});

describe('a port this job does not own', () => {
  it('refuses a listener launchd did not start, and names both pids', async () => {
    const store = pairedStore('aion.sqlite', dir);
    const machine = machineActions({ jobPid: 6316, listeners: [4242] });

    const binding = await verifyServiceBinding(
      health({ store_id: store.id }),
      intended({ storePath: store.path }),
      machine.actions,
    );

    expect(binding.kind).toBe('unowned');
    expect(binding.kind === 'unowned' ? binding.reason : '').toContain('4242');
    expect(binding.kind === 'unowned' ? binding.reason : '').toContain('6316');
  });

  it('refuses when launchd names no process for the job', async () => {
    const store = pairedStore('aion.sqlite', dir);
    const machine = machineActions({ listeners: [4242] });

    const binding = await verifyServiceBinding(
      health({ store_id: store.id }),
      intended({ storePath: store.path }),
      machine.actions,
    );

    expect(binding.kind).toBe('unowned');
    expect(binding.kind === 'unowned' ? binding.reason : '').toContain(MCP_LAUNCH_LABEL);
  });

  /**
   * Two listeners on one port and the job is one of them. That the job is in the list says the
   * job has a socket there; it does not say the 200 came back from the job rather than from the
   * other one, and a replacement decided on the weaker fact bounces the wrong service.
   */
  it('refuses when the answer cannot be tied to one listener', async () => {
    const store = pairedStore('aion.sqlite', dir);
    const machine = machineActions({ jobPid: 6316, listeners: [4242, 6316] });

    const binding = await verifyServiceBinding(
      health({ store_id: store.id }),
      intended({ storePath: store.path }),
      machine.actions,
    );

    expect(binding.kind).toBe('unowned');
    expect(binding.kind === 'unowned' ? binding.reason : '').toContain('4242');
  });

  it('refuses when the port itself could not be read', async () => {
    const blind: HostActions = {
      run: (program) =>
        Promise.resolve(
          program === 'lsof'
            ? { ok: false, stdout: '', stderr: 'spawn lsof ENOENT' }
            : { ok: true, stdout: '\tpid = 6316\n', stderr: '' },
        ),
      fetch: () => Promise.reject(new Error('no download belongs in this path')),
    };

    const binding = await verifyServiceBinding(health(), intended(), blind);

    expect(binding.kind).toBe('unowned');
  });

  it('refuses when nothing on the port can be read, however healthy the answer looked', async () => {
    const store = pairedStore('aion.sqlite', dir);
    const machine = machineActions({ jobPid: 6316, listeners: [] });

    const binding = await verifyServiceBinding(
      health({ store_id: store.id }),
      intended({ storePath: store.path }),
      machine.actions,
    );

    expect(binding.kind).toBe('unowned');
  });

  /** Identification only. A port owner that is not ours is named, never signalled. */
  it('runs nothing that stops or signals a process', async () => {
    const machine = machineActions({ jobPid: 6316, listeners: [4242] });

    await verifyServiceBinding(health(), intended(), machine.actions);

    expect(machine.calls.join('\n')).not.toMatch(/\b(kill|pkill|bootout|kickstart|killall)\b/);
  });
});

describe('the readers the proof rests on', () => {
  it('takes every pid lsof lists for the port', async () => {
    const machine = machineActions({ listeners: [4242, 6316] });

    expect(await readListenerPids(machine.actions, 8765)).toEqual({
      known: true,
      value: [4242, 6316],
    });
  });

  it('answers with nothing for a pid that has exited, which is the liveness test', async () => {
    const machine = machineActions({ processes: { 6316: 'node main.js' } });

    expect(await readProcessCommand(machine.actions, 6316)).toEqual({
      known: true,
      value: 'node main.js',
    });
    expect(await readProcessCommand(machine.actions, 4242)).toEqual({
      known: true,
      value: undefined,
    });
  });

  /**
   * The mistake one level below `bootout`: `lsof`, `ps` and `launchctl` all fail for reasons that
   * say nothing about what they were asked, and a caller proving a service stopped must be able
   * to tell that from an answer.
   */
  it('separates a command that could not run from a thing that is not there', async () => {
    const broken: HostActions = {
      run: (program) =>
        Promise.resolve(
          program === 'launchctl'
            ? { ok: false, stdout: '', stderr: 'print: permission denied' }
            : { ok: false, stdout: '', stderr: `spawn ${program} ENOENT` },
        ),
      fetch: () => Promise.reject(new Error('no download belongs in this path')),
    };

    expect(await readListenerPids(broken, 8765)).toMatchObject({ known: false });
    expect(await readProcessCommand(broken, 6316)).toMatchObject({ known: false });
    expect(await readLaunchdJob(broken)).toMatchObject({ known: false });
  });

  /** The two exits that are readings: neither command prints anything when it matches nothing. */
  it('reads an empty non-zero exit as nothing found, which is what lsof and ps do', async () => {
    const empty: HostActions = {
      run: () => Promise.resolve({ ok: false, stdout: '', stderr: '' }),
      fetch: () => Promise.reject(new Error('no download belongs in this path')),
    };

    expect(await readListenerPids(empty, 8765)).toEqual({ known: true, value: [] });
    expect(await readProcessCommand(empty, 6316)).toEqual({ known: true, value: undefined });
  });

  /** One process holding the v4 and the v6 socket is listed once per socket. */
  it('counts a pid listed twice for the same port once', async () => {
    const doubled: HostActions = {
      run: () => Promise.resolve({ ok: true, stdout: '6316\n6316\n', stderr: '' }),
      fetch: () => Promise.reject(new Error('no download belongs in this path')),
    };

    expect(await readListenerPids(doubled, 8765)).toEqual({ known: true, value: [6316] });
  });
});

describe('what a store file says it is', () => {
  /** The reader must not be the thing that makes a substrate out of whatever it was pointed at. */
  it('leaves an existing database exactly as it found it', () => {
    const path = join(dir, 'not-a-substrate.sqlite');
    const store = new SqliteStore({ filePath: path });
    store.close();
    const before = readFileSync(path).byteLength;

    expect(readStoreIdentity(path)).toBeUndefined();
    expect(observeStoreIdentity(path)).toEqual({ kind: 'unpaired' });
    expect(readFileSync(path).byteLength).toBe(before);
  });

  it('tells a file it could not read from a path carrying no store', () => {
    const corrupt = join(dir, 'corrupt.sqlite');
    writeFileSync(corrupt, 'this is not a database');

    expect(observeStoreIdentity(join(dir, 'never-made.sqlite'))).toEqual({ kind: 'missing' });
    expect(observeStoreIdentity(corrupt)).toMatchObject({ kind: 'unreadable' });
  });
});
