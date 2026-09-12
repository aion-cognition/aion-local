import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GDS_RELEASES, gdsJarName, gdsJarUrl } from './gds-releases.js';
import { NativeSetupError, type HostActions, type HostResult } from './host-actions.js';
import {
  applyNeo4jSettings,
  ensureGdsPlugin,
  ensureNeo4jInstalled,
  NEO4J_SETTINGS,
  passwordRefusal,
  readInstalledServerVersion,
  resolveNeo4jLayout,
  setInitialPassword,
  startNeo4j,
  type Neo4jLayout,
} from './native-graph.js';

/**
 * The install steps, with the machine behind a seam. Nothing here installs, starts or downloads
 * anything: the package manager, the service and the network are all scripted, and what each case
 * asserts is the sequence init would take and the refusal it takes instead.
 */

type Scripted = {
  actions: HostActions;
  readonly calls: string[];
  /** What a fetch writes, so a case can make the digest match or not. */
  body: Buffer;
};

function scripted(answers: Record<string, HostResult | undefined>, body = 'jar'): Scripted {
  const calls: string[] = [];
  const state: Scripted = {
    calls,
    body: Buffer.from(body),
    actions: {
      run: (program, args) => {
        const command = [program, ...args].join(' ');
        calls.push(command);
        return Promise.resolve(
          answers[command] ?? answers[program] ?? { ok: false, stdout: '', stderr: 'not scripted' },
        );
      },
      fetch: (url, target) => {
        calls.push(`fetch ${url}`);
        writeFileSync(target, state.body);
        return Promise.resolve({ sha256: 'digest-of-what-arrived', bytes: state.body.byteLength });
      },
    },
  };
  return state;
}

const ok = (stdout = ''): HostResult => ({ ok: true, stdout, stderr: '' });

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-native-graph-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function distribution(home: string): string {
  mkdirSync(join(home, 'conf'), { recursive: true });
  mkdirSync(join(home, 'bin'), { recursive: true });
  writeFileSync(join(home, 'conf', 'neo4j.conf'), '# stock config\n');
  writeFileSync(join(home, 'bin', 'neo4j'), '');
  writeFileSync(join(home, 'bin', 'neo4j-admin'), '');
  return home;
}

function layoutFor(home: string, over: Partial<Neo4jLayout> = {}): Neo4jLayout {
  return {
    home,
    confFile: join(home, 'conf', 'neo4j.conf'),
    pluginsDir: join(home, 'plugins'),
    adminBin: join(home, 'bin', 'neo4j-admin'),
    serverBin: join(home, 'bin', 'neo4j'),
    brewManaged: false,
    ...over,
  };
}

describe('finding the distribution', () => {
  it('takes NEO4J_HOME when it holds a config file, and reads the tools beside it', async () => {
    const home = distribution(join(dir, 'neo4j'));
    const state = scripted({ brew: { ok: false, stdout: '', stderr: 'no brew' } });

    const layout = await resolveNeo4jLayout(state.actions, { NEO4J_HOME: home });

    expect(layout).toMatchObject({
      home,
      confFile: join(home, 'conf', 'neo4j.conf'),
      pluginsDir: join(home, 'plugins'),
      brewManaged: false,
    });
    expect(layout?.adminBin).toBe(join(home, 'bin', 'neo4j-admin'));
  });

  it('probes the brew prefix, including the libexec layout the formula uses', async () => {
    const prefix = join(dir, 'opt', 'neo4j');
    const home = distribution(join(prefix, 'libexec'));
    const state = scripted({ [`brew --prefix neo4j`]: ok(`${prefix}\n`) });

    const layout = await resolveNeo4jLayout(state.actions, {});

    expect(layout?.home).toBe(home);
    // Under the brew prefix, which is what decides how it gets started.
    expect(layout?.brewManaged).toBe(true);
  });

  it('answers nothing rather than a path, when no candidate holds a config file', async () => {
    const state = scripted({ [`brew --prefix neo4j`]: ok(`${join(dir, 'absent')}\n`) });

    expect(await resolveNeo4jLayout(state.actions, {})).toBeUndefined();
  });
});

describe('installing it', () => {
  it('leaves an installed server alone', async () => {
    const home = distribution(join(dir, 'neo4j'));
    const state = scripted({});
    const said: string[] = [];

    const layout = await ensureNeo4jInstalled(state.actions, { NEO4J_HOME: home }, (line) =>
      said.push(line),
    );

    expect(layout.home).toBe(home);
    expect(state.calls.some((call) => call.startsWith('brew install'))).toBe(false);
    expect(said.join('\n')).toContain('present');
  });

  it('installs through homebrew when nothing is there, then resolves what it installed', async () => {
    const prefix = join(dir, 'opt', 'neo4j');
    const state = scripted({
      'brew --version': ok('Homebrew 6.0.21'),
      'brew install neo4j': ok(''),
      'brew --prefix neo4j': ok(`${prefix}\n`),
    });
    // The formula's own layout appears only after the install, which is the second probe.
    const originalRun = state.actions.run;
    const actions: HostActions = {
      fetch: state.actions.fetch,
      run: async (program, args) => {
        const result = await originalRun(program, args);
        if ([program, ...args].join(' ') === 'brew install neo4j') {
          distribution(join(prefix, 'libexec'));
        }
        return result;
      },
    };

    const layout = await ensureNeo4jInstalled(actions, {}, () => undefined);

    expect(layout.home).toBe(join(prefix, 'libexec'));
    expect(state.calls).toContain('brew install neo4j');
  });

  it('names the two commands when there is no package manager to install with', async () => {
    const state = scripted({});

    await expect(ensureNeo4jInstalled(state.actions, {}, () => undefined)).rejects.toThrow(
      NativeSetupError,
    );
    // Doing-first, printing-as-fallback: the fallback is the exact command, not a description.
    await expect(ensureNeo4jInstalled(state.actions, {}, () => undefined)).rejects.toThrow(
      'brew install neo4j',
    );
  });

  it('reports what brew said when the install itself failed', async () => {
    const state = scripted({
      'brew --version': ok('Homebrew 6.0.21'),
      'brew install neo4j': { ok: false, stdout: '', stderr: 'No available formula' },
    });

    await expect(ensureNeo4jInstalled(state.actions, {}, () => undefined)).rejects.toThrow(
      'No available formula',
    );
  });
});

describe('reading the installed version', () => {
  it('asks the binary first', async () => {
    const home = distribution(join(dir, 'neo4j'));
    const state = scripted({ [join(home, 'bin', 'neo4j')]: ok('neo4j 2026.07.1\n') });

    expect(await readInstalledServerVersion(layoutFor(home), state.actions)).toBe('2026.07.1');
  });

  it('falls back to the kernel jar, for a layout whose binary needs a JVM it has not got', async () => {
    const home = distribution(join(dir, 'neo4j'));
    mkdirSync(join(home, 'lib'), { recursive: true });
    writeFileSync(join(home, 'lib', 'neo4j-kernel-2026.08.1.jar'), '');
    const state = scripted({});

    expect(await readInstalledServerVersion(layoutFor(home), state.actions)).toBe('2026.08.1');
  });

  it('answers nothing rather than a guess', async () => {
    const home = distribution(join(dir, 'neo4j'));
    const state = scripted({});

    expect(await readInstalledServerVersion(layoutFor(home), state.actions)).toBeUndefined();
  });
});

describe('the graph-data-science plugin', () => {
  it('keeps a jar somebody already placed', async () => {
    const home = distribution(join(dir, 'neo4j'));
    mkdirSync(join(home, 'plugins'), { recursive: true });
    writeFileSync(join(home, 'plugins', 'neo4j-graph-data-science-2026.07.0.jar'), '');
    const state = scripted({});
    const said: string[] = [];

    await ensureGdsPlugin(layoutFor(home), '2026.07.1', state.actions, (line) => said.push(line));

    expect(state.calls).toEqual([]);
    expect(said.join('\n')).toContain('present');
  });

  it('fetches the release for the server series and keeps it when the digest matches', async () => {
    const home = distribution(join(dir, 'neo4j'));
    const release = GDS_RELEASES['2026.07'];
    const state = scripted({});
    state.actions = {
      run: state.actions.run,
      fetch: (url: string, target: string) => {
        state.calls.push(`fetch ${url}`);
        writeFileSync(target, 'jar');
        return Promise.resolve({ sha256: release?.sha256 ?? '', bytes: 3 });
      },
    };

    await ensureGdsPlugin(layoutFor(home), '2026.07.1', state.actions, () => undefined);

    expect(state.calls).toEqual([`fetch ${gdsJarUrl(release?.version ?? '')}`]);
    expect(existsSync(join(home, 'plugins', gdsJarName(release?.version ?? '')))).toBe(true);
  });

  it('deletes a download whose digest does not match, and installs nothing', async () => {
    const home = distribution(join(dir, 'neo4j'));
    const state = scripted({});

    // No digest, no install: a plugin jar runs unsandboxed inside the database process.
    await expect(
      ensureGdsPlugin(layoutFor(home), '2026.07.1', state.actions, () => undefined),
    ).rejects.toThrow('did not match its recorded digest');
    expect(
      existsSync(join(home, 'plugins', gdsJarName(GDS_RELEASES['2026.07']?.version ?? ''))),
    ).toBe(false);
  });

  it('refuses a server series nobody measured, with the command that does it by hand', async () => {
    const home = distribution(join(dir, 'neo4j'));
    const state = scripted({});

    await expect(
      ensureGdsPlugin(layoutFor(home), '2027.01.0', state.actions, () => undefined),
    ).rejects.toThrow('no measured graph-data-science digest for a 2027.01 server');
    expect(state.calls).toEqual([]);
  });
});

describe('the config file', () => {
  it('adds what is missing, replaces what disagrees, and leaves the rest exactly as it was', () => {
    const confFile = join(dir, 'neo4j.conf');
    writeFileSync(
      confFile,
      ['# a comment somebody wrote', 'server.memory.heap.max_size=4G', 'dbms.other=keep'].join(
        '\n',
      ),
    );

    const changed = applyNeo4jSettings(confFile, NEO4J_SETTINGS);
    const written = readFileSync(confFile, 'utf8');

    expect(changed).toContain('server.memory.heap.max_size');
    expect(written).toContain('server.memory.heap.max_size=1G');
    expect(written).toContain('# a comment somebody wrote');
    expect(written).toContain('dbms.other=keep');
    // Both procedure lines, which is what GDS needs, and the retention the native profile takes.
    expect(written).toContain('dbms.security.procedures.unrestricted=gds.*');
    expect(written).toContain('dbms.security.procedures.allowlist=gds.*');
    expect(written).toContain('db.tx_log.rotation.retention_policy=1 days 256M');
    expect(written).toContain('server.bolt.listen_address=127.0.0.1:7687');
  });

  it('changes nothing on a second run, which is what makes a re-run of init a no-op', () => {
    const confFile = join(dir, 'neo4j.conf');
    writeFileSync(confFile, '');
    applyNeo4jSettings(confFile, NEO4J_SETTINGS);
    const first = readFileSync(confFile, 'utf8');

    expect(applyNeo4jSettings(confFile, NEO4J_SETTINGS)).toEqual([]);
    expect(readFileSync(confFile, 'utf8')).toBe(first);
  });
});

describe('starting it, and the password', () => {
  it('uses brew services for a brew install and the binary otherwise', async () => {
    const home = distribution(join(dir, 'neo4j'));
    const brew = scripted({ 'brew services start neo4j': ok('') });
    await startNeo4j(layoutFor(home, { brewManaged: true }), brew.actions, () => undefined);
    expect(brew.calls).toEqual(['brew services start neo4j']);

    const bare = scripted({ [`${join(home, 'bin', 'neo4j')} start`]: ok('') });
    await startNeo4j(layoutFor(home), bare.actions, () => undefined);
    expect(bare.calls).toEqual([`${join(home, 'bin', 'neo4j')} start`]);
  });

  it('names the foreground command when the start fails', async () => {
    const home = distribution(join(dir, 'neo4j'));
    const state = scripted({});

    await expect(startNeo4j(layoutFor(home), state.actions, () => undefined)).rejects.toThrow(
      'console',
    );
  });

  it('sets the initial password through the admin tool, and answers whether it took', async () => {
    const home = distribution(join(dir, 'neo4j'));
    const admin = join(home, 'bin', 'neo4j-admin');
    const state = scripted({ [`${admin} dbms set-initial-password secret`]: ok('') });

    expect(await setInitialPassword(layoutFor(home), 'secret', state.actions)).toBe(true);
    expect(state.calls).toEqual([`${admin} dbms set-initial-password secret`]);
    // An already-initialized server refuses it, and that is not a failure of the install: Bolt is
    // what judges the password, and its refusal is the one that names both ways out.
    expect(await setInitialPassword(layoutFor(home), 'other', state.actions)).toBe(false);
  });

  it('offers both ways out of a password the server does not accept', () => {
    const home = distribution(join(dir, 'neo4j'));
    const refusal = passwordRefusal('bolt://127.0.0.1:7687', layoutFor(home));

    expect(refusal.commands.join('\n')).toContain('AION_NEO4J_PASSWORD');
    expect(refusal.commands.join('\n')).toContain('set-initial-password');
  });
});
