import { DEFAULTS, loadConfig } from '@aion/core';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  applyNativeEnv,
  describeInstallProfile,
  nativeAddresses,
  nativeDataDir,
  planNativeEnv,
  refuseProfileSwitch,
  storeDropCommands,
  storePairing,
  storePairingRefusal,
} from './install-profile.js';

const HOME = '/Users/someone';

describe('the addresses a native install records', () => {
  it('moves every compose-shaped address to a host one, under one data directory', () => {
    const values = new Map(nativeAddresses(HOME).map(([key, value]) => [key, value]));

    expect(values.get('AION_INSTALL_PROFILE')).toBe('native');
    expect(values.get('AION_NEO4J_URI')).toBe('bolt://127.0.0.1:7687');
    expect(values.get('AION_OLLAMA_URL')).toBe('http://127.0.0.1:11434');
    expect(values.get('AION_DATA_DIR')).toBe(nativeDataDir(HOME));
    // Both stores and the log under the one directory, which is what makes the reset a pair of
    // drops rather than a hunt.
    expect(values.get('AION_SQLITE_PATH')?.startsWith(nativeDataDir(HOME))).toBe(true);
    expect(values.get('AION_LOG_FILE')?.startsWith(nativeDataDir(HOME))).toBe(true);
  });

  it('names only variables the config surface knows, and values it accepts', () => {
    // The drift guard. `loadConfig` refuses an unknown `AION_*` variable outright, so a renamed
    // knob or a typo here fails this rather than surfacing as a native install that cannot boot.
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of nativeAddresses(HOME)) {
      env[key] = value;
    }
    const config = loadConfig(env);

    expect(config.install.profile).toBe('native');
    expect(config.neo4j.uri).toBe('bolt://127.0.0.1:7687');
    expect(config.operational.dataDir).toBe(nativeDataDir(HOME));
  });
});

describe('planNativeEnv', () => {
  const template = (key: string): string | undefined =>
    key === 'AION_NEO4J_URI' ? 'bolt://neo4j:7687' : undefined;

  it('converts a value the template still owns, and one the file never carried', () => {
    const plan = planNativeEnv({
      home: HOME,
      current: (key) => (key === 'AION_NEO4J_URI' ? 'bolt://neo4j:7687' : undefined),
      template,
    });

    expect(plan.every((step) => step.action === 'wrote')).toBe(true);
  });

  it('keeps an address this install chose for itself', () => {
    const plan = planNativeEnv({
      home: HOME,
      current: (key) => (key === 'AION_NEO4J_URI' ? 'bolt://graph.lan:7687' : undefined),
      template,
    });

    // A remote Neo4j somebody pointed this install at is not a compose leftover, and a re-run of
    // init must not take it back.
    expect(plan.find((step) => step.key === 'AION_NEO4J_URI')?.action).toBe('kept');
    expect(plan.filter((step) => step.action === 'wrote')).toHaveLength(5);
  });

  it('reads a value already equal to the native one as written rather than as a choice', () => {
    const plan = planNativeEnv({
      home: HOME,
      current: (key) => (key === 'AION_NEO4J_URI' ? 'bolt://127.0.0.1:7687' : undefined),
      template,
    });

    expect(plan.find((step) => step.key === 'AION_NEO4J_URI')?.action).toBe('wrote');
  });
});

describe('applyNativeEnv', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-native-env-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the file and this process together, and skips what it kept', () => {
    const envPath = join(dir, '.env');
    writeFileSync(envPath, 'AION_NEO4J_URI=bolt://graph.lan:7687\nAION_LOG_LEVEL=info\n');
    const env: NodeJS.ProcessEnv = {};

    applyNativeEnv(
      envPath,
      [
        { key: 'AION_DATA_DIR', value: '/tmp/data', action: 'wrote' },
        { key: 'AION_NEO4J_URI', value: 'bolt://127.0.0.1:7687', action: 'kept' },
      ],
      env,
    );

    const written = readFileSync(envPath, 'utf8');
    expect(written).toContain('AION_DATA_DIR=/tmp/data');
    // Untouched, and so is every line this build does not own.
    expect(written).toContain('AION_NEO4J_URI=bolt://graph.lan:7687');
    expect(written).toContain('AION_LOG_LEVEL=info');
    // The process copy is what the rest of the run reads: nothing on the host loads `.env`.
    expect(env.AION_DATA_DIR).toBe('/tmp/data');
    expect(env.AION_NEO4J_URI).toBeUndefined();
  });
});

describe('storePairing', () => {
  it('reads a substrate in both stores as a pair, and an empty machine as fresh', () => {
    expect(storePairing({ graphEstablished: true, databaseEstablished: true })).toBe('paired');
    expect(storePairing({ graphEstablished: false, databaseEstablished: false })).toBe('fresh');
  });

  it('names which half survived a reset that dropped one store', () => {
    expect(storePairing({ graphEstablished: true, databaseEstablished: false })).toBe(
      'graph-without-database',
    );
    expect(storePairing({ graphEstablished: false, databaseEstablished: true })).toBe(
      'database-without-graph',
    );
  });
});

describe('the half-reset refusal', () => {
  it('names both drops for the profile that owns the stores', () => {
    const docker = storePairingRefusal(
      'graph-without-database',
      'docker',
      DEFAULTS.operational.dataDir,
    ).join('\n');

    expect(docker).toContain('docker volume rm aion_aion-neo4j aion_aion-data');
    expect(docker).toContain('the graph holds a substrate');

    const native = storePairingRefusal('database-without-graph', 'native', '/home/x/.aion').join(
      '\n',
    );

    expect(native).toContain('rm -rf /home/x/.aion');
    // The Neo4j data directory on a native install belongs to a server this build did not place,
    // so the remedy is the lookup rather than a path that may not be there.
    expect(native).toContain("SHOW SETTINGS 'server.directories.data'");
    expect(native).toContain('the database holds schema history');
  });

  it('gives the docker profile two commands and the native profile a directory to remove', () => {
    expect(storeDropCommands('docker', '/data')).toHaveLength(2);
    expect(storeDropCommands('native', '/home/x/.aion')[0]).toBe('rm -rf /home/x/.aion');
  });
});

describe('asking for the other profile', () => {
  it('refuses docker on a native substrate, rather than validating and doing nothing', () => {
    // Only the native branch acts on the flag, so this used to parse, pass validation, and leave
    // init running against the host addresses it had just been told to leave.
    expect(() => {
      refuseProfileSwitch('docker', 'native');
    }).toThrow('this substrate is native; switching profiles is a reset-and-init');
    expect(() => {
      refuseProfileSwitch('docker', 'native');
    }).toThrow('AION_INSTALL_PROFILE=docker');
  });

  it('lets the flag through when it names the profile already in force', () => {
    expect(() => {
      refuseProfileSwitch('native', 'native');
    }).not.toThrow();
    expect(() => {
      refuseProfileSwitch('docker', 'docker');
    }).not.toThrow();
    expect(() => {
      refuseProfileSwitch(undefined, 'native');
    }).not.toThrow();
  });

  it('lets native through on a docker-shaped config, which is the first choice', () => {
    // `docker` is the code default, so a config that reads docker cannot be told apart from one
    // nobody chose. Choosing native there is the flag doing its job.
    expect(() => {
      refuseProfileSwitch('native', 'docker');
    }).not.toThrow();
  });
});

describe('describeInstallProfile', () => {
  it('says which substrate a report is about, and where the native one keeps its data', () => {
    expect(describeInstallProfile(DEFAULTS)).toContain('compose services');
    expect(
      describeInstallProfile({
        ...DEFAULTS,
        install: { profile: 'native' },
        operational: { ...DEFAULTS.operational, dataDir: '/home/x/.aion' },
      }),
    ).toContain('/home/x/.aion');
  });
});
