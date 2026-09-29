import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { hostRun, NativeSetupError, type HostActions } from './host-actions.js';
import {
  isVirginNeo4jStore,
  passwordRefusal,
  resolveNeo4jLayout,
  setInitialPassword,
  startNeo4j,
  type Neo4jLayout,
} from './native-graph.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-init-review-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function layout(): Neo4jLayout {
  const home = join(dir, 'neo4j');
  mkdirSync(join(home, 'conf'), { recursive: true });
  mkdirSync(join(home, 'bin'), { recursive: true });
  writeFileSync(join(home, 'conf', 'neo4j.conf'), '');
  writeFileSync(join(home, 'bin', 'neo4j'), '');
  return {
    home,
    confFile: join(home, 'conf', 'neo4j.conf'),
    pluginsDir: join(home, 'plugins'),
    adminBin: undefined,
    serverBin: join(home, 'bin', 'neo4j'),
    brewManaged: false,
  };
}

function scripted(calls: string[]): HostActions {
  return {
    run: async (program, args) => {
      calls.push([program, ...args].join(' '));
      return { ok: program !== 'brew', stdout: '', stderr: '' };
    },
    fetch: async () => {
      throw new Error('no download is allowed in this test');
    },
  };
}

it('does not prescribe a first-boot seed as an initialized server password reset', async () => {
  const installed = layout();
  mkdirSync(join(installed.home, 'data', 'databases', 'system'), { recursive: true });
  const refusal = passwordRefusal('bolt://localhost:7687', installed, scripted([]), {});
  console.log(JSON.stringify({ case: 'initialized-remedy', commands: refusal.commands }));
  expect(refusal.commands.join('\n')).toContain('AION_NEO4J_PASSWORD');
  expect(refusal.commands.join('\n')).not.toContain('set-initial-password');
});

it('refuses before startup when a virgin layout has no password-setting tool', async () => {
  const installed = layout();
  const calls: string[] = [];
  const actions = scripted(calls);
  const resolved = await resolveNeo4jLayout(actions, { NEO4J_HOME: installed.home });
  expect(resolved?.adminBin).toBeUndefined();
  expect(resolved?.serverBin).toBe(installed.serverBin);
  let failure: unknown;
  try {
    // The two production calls in native-install.ts:160-161, with only host effects scripted.
    await setInitialPassword(resolved!, 'test-password', actions, {});
    await startNeo4j(resolved!, actions, () => undefined);
  } catch (error) {
    failure = error;
  }
  console.log(JSON.stringify({ case: 'virgin-without-admin', failure: String(failure), calls }));
  expect.soft(failure).toBeInstanceOf(NativeSetupError);
  expect(calls).not.toContain(`${installed.serverBin} start`);
});

it('keeps the missing-tool no-op for an initialized store', async () => {
  const installed = layout();
  mkdirSync(join(installed.home, 'data', 'databases', 'system'), { recursive: true });
  const calls: string[] = [];
  await expect(
    setInitialPassword(installed, 'test-password', scripted(calls), {}),
  ).resolves.toBeUndefined();
  expect(calls).toEqual([]);
});

it.each(['absolute', 'relative'] as const)('uses the configured %s data directory', (kind) => {
  const installed = layout();
  const data = kind === 'absolute' ? join(dir, 'external-data') : 'relocated-data';
  const realData = kind === 'absolute' ? data : join(installed.home, data);
  writeFileSync(installed.confFile, `server.directories.data=${data}\n`);
  mkdirSync(join(realData, 'databases', 'system'), { recursive: true });
  expect(isVirginNeo4jStore(installed)).toBe(false);
});

it('does not treat an auth seed alone as an initialized store', () => {
  const installed = layout();
  mkdirSync(join(installed.home, 'data', 'dbms'), { recursive: true });
  writeFileSync(join(installed.home, 'data', 'dbms', 'auth.ini'), 'fake seed');
  expect(isVirginNeo4jStore(installed)).toBe(true);
});

it('passes the supplied Java environment to the actual subprocess seam', async () => {
  const result = await hostRun(
    process.execPath,
    [
      '-e',
      'process.stdout.write(JSON.stringify({java:process.env.JAVA_HOME,kept:process.env.INIT_REVIEW_KEEP}))',
    ],
    { JAVA_HOME: '/fake/jdk', INIT_REVIEW_KEEP: 'retained' },
  );
  expect(result.ok).toBe(true);
  expect(JSON.parse(result.stdout)).toEqual({ java: '/fake/jdk', kept: 'retained' });
});
