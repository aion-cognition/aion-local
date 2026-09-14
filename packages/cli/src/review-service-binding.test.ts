import { DEFAULTS, SqliteStore } from '@aion/core';
import { beginSubstratePairing } from '@aion/core/infrastructure/sqlite/publication-control.js';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { readMcpHealth } from './compose.js';
import type { HostActions } from './host-actions.js';
import { launchAgentPath } from './launchd.js';
import { prepareNativeService } from './native-install.js';
import { readStoreIdentity, verifyServiceBinding } from './service-binding.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-binding-review-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function paired() {
  const path = join(dir, 'aion.sqlite');
  const store = new SqliteStore({ filePath: path });
  const id = beginSubstratePairing(store.db, 1).substrateId;
  store.close();
  return { path, id };
}

function machine(listeners: number[], jobPid?: number) {
  const calls: string[] = [];
  const actions: HostActions = {
    run: async (program, args) => {
      calls.push([program, ...args].join(' '));
      if (program === 'launchctl' && args[0] === 'print') {
        return jobPid === undefined
          ? { ok: false, stdout: '', stderr: 'Could not find service' }
          : { ok: true, stdout: `pid = ${jobPid}`, stderr: '' };
      }
      if (program === 'lsof') {
        return { ok: true, stdout: listeners.join('\n'), stderr: '' };
      }
      return { ok: true, stdout: '', stderr: '' };
    },
    fetch: async () => {
      throw new Error('no download');
    },
  };
  return { actions, calls };
}

it('does not rewrite or bootstrap before refusing a foreign listener when the plist differs', async () => {
  vi.stubEnv('AION_BUILD_SHA', 'review');
  const store = paired();
  const repoDir = join(dir, 'repo');
  mkdirSync(join(repoDir, 'packages', 'mcp', 'dist'), { recursive: true });
  writeFileSync(join(repoDir, 'packages', 'mcp', 'dist', 'main.js'), '');
  writeFileSync(join(repoDir, '.env'), '');
  const plist = launchAgentPath(dir);
  mkdirSync(dirname(plist), { recursive: true });
  writeFileSync(plist, 'prior plist');
  const host = machine([4242]);
  const result = prepareNativeService(
    {
      ...DEFAULTS,
      sqlite: { ...DEFAULTS.sqlite, path: store.path },
      logging: { ...DEFAULTS.logging, filePath: join(dir, 'log') },
    },
    repoDir,
    () => undefined,
    {
      home: dir,
      actions: host.actions,
      waitFor: async () => undefined,
      readHealth: async () => ({ status: 'ok', build_sha: 'review', store_id: store.id }),
    },
  );
  await expect(result).rejects.toThrow();
  console.log(JSON.stringify({ case: 'foreign-with-different-plist', calls: host.calls }));
  expect.soft(host.calls.some((call) => /bootout|bootstrap/.test(call))).toBe(false);
  expect(readFileSync(plist, 'utf8')).toBe('prior plist');
});

it('does not equate one matching pid among several listeners with the health responder', async () => {
  const store = paired();
  const host = machine([4242, 6316], 6316);
  const result = await verifyServiceBinding(
    { status: 'ok', build_sha: 'review', store_id: store.id },
    { port: 8765, buildSha: 'review', storePath: store.path },
    host.actions,
  );
  console.log(JSON.stringify({ case: 'ambiguous-listener', result }));
  expect(result.kind).not.toBe('bound');
});

it('does not certify code identity from two missing build stamps', async () => {
  const store = paired();
  const host = machine([6316], 6316);
  const result = await verifyServiceBinding(
    { status: 'ok', store_id: store.id },
    { port: 8765, buildSha: 'unstamped', storePath: store.path },
    host.actions,
  );
  console.log(JSON.stringify({ case: 'unknown-build-is-not-equality', result }));
  expect(result.kind).not.toBe('bound');
});

it('reads identity without installing the application schema into an existing database', () => {
  const path = join(dir, 'existing.sqlite');
  const db = new Database(path);
  db.exec('CREATE TABLE keep_me (value TEXT)');
  db.prepare('INSERT INTO keep_me VALUES (?)').run('keep');
  db.close();
  readStoreIdentity(path);
  const after = new Database(path, { readonly: true });
  try {
    const tables = after
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all();
    console.log(JSON.stringify({ case: 'identity-read-schema', tables }));
    expect(tables).toEqual([{ name: 'keep_me' }]);
    expect(after.prepare('SELECT value FROM keep_me').get()).toEqual({ value: 'keep' });
  } finally {
    after.close();
  }
});

it('reads a paired WAL store without creating a new pairing identity', () => {
  const store = paired();
  expect(readStoreIdentity(store.path)).toBe(store.id);
  expect(existsSync(store.path)).toBe(true);
});

it.each(['headers', 'body'] as const)(
  'bounds the health read while waiting for %s',
  async (phase) => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    });
    let release: (() => void) | undefined;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const pending = new Promise<never>((_resolve, reject) => {
        release = () => reject(new Error('test cleanup'));
        init?.signal?.addEventListener('abort', () => reject(new Error('deadline reached')), {
          once: true,
        });
      });
      if (phase === 'headers') {
        return pending;
      }
      const response = new Response(null, { status: 200 });
      vi.spyOn(response, 'json').mockReturnValue(pending);
      return response;
    });
    let settled = false;
    const read = readMcpHealth(8765, { fetchImpl }).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(600_000);
    const hadBound = settled;
    release?.();
    await read;
    console.log(JSON.stringify({ case: 'health-bound', phase, hadBound }));
    expect(hadBound).toBe(true);
  },
);
