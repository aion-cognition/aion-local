import { DEFAULTS } from '@aion/core';
import type { Driver } from 'neo4j-driver';
import { describe, expect, it } from 'vitest';

import {
  graphPairingCheck,
  installProfileCheck,
  OLLAMA_ENV_PROBE,
  ollamaRuntimeCheck,
  storePairingDetail,
} from './doctor-checks.js';

/**
 * The checks the install profile added. The graph ones run against a fake driver that answers by
 * query text, which is the same predicate style the rest of the repo's fake drivers use; no Cypher
 * here is executed anywhere.
 */

const NATIVE = {
  ...DEFAULTS,
  install: { profile: 'native' as const },
  operational: { ...DEFAULTS.operational, dataDir: '/home/x/.aion' },
};

type FakeServer = {
  readonly agent?: string;
  readonly gdsVersion?: string;
  readonly pluginsDir?: string;
};

function driverFor(server: FakeServer): Driver {
  return {
    getServerInfo: () => Promise.resolve({ agent: server.agent }),
    executeQuery: (cypher: string) => {
      if (cypher.includes('gds.version')) {
        if (server.gdsVersion === undefined) {
          return Promise.reject(new Error('Unknown procedure gds.version'));
        }
        return Promise.resolve({ records: [{ get: () => server.gdsVersion }] });
      }
      if (cypher.includes('SHOW SETTINGS')) {
        return Promise.resolve({ records: [{ get: () => server.pluginsDir }] });
      }
      return Promise.reject(new Error(`unexpected query: ${cypher}`));
    },
  } as unknown as Driver;
}

describe('install-profile', () => {
  it('says which substrate the rest of the report is about', () => {
    expect(installProfileCheck(DEFAULTS).detail).toContain('docker');
    expect(installProfileCheck(NATIVE).detail).toContain('native');
  });
});

describe('the neo4j pairing check', () => {
  it('passes the pairing the substrate was measured on', async () => {
    const result = await graphPairingCheck(
      driverFor({ agent: 'Neo4j/2026.07.1', gdsVersion: '2026.07.0' }),
      'bolt://127.0.0.1:7687',
    );

    expect(result).toMatchObject({ ok: true });
    expect(result.warn).toBeUndefined();
    expect(result.detail).toContain('a verified pairing');
  });

  it('passes the Homebrew pairing on the census run against it', async () => {
    const result = await graphPairingCheck(
      driverFor({ agent: 'Neo4j/2026.08.1', gdsVersion: '2026.08.1' }),
      'bolt://127.0.0.1:7687',
    );

    expect(result).toMatchObject({ ok: true });
    expect(result.warn).toBeUndefined();
    expect(result.detail).toContain(
      'a verified pairing (2026.08 with graph-data-science 2026.08.1',
    );
    expect(result.detail).toContain('census of 2026-09-27');
  });

  it('warns on a matched pair no census has run on rather than failing a working substrate', async () => {
    // The two halves agree, which is the requirement; nobody has run the procedure census on the
    // series, which is the warning.
    const result = await graphPairingCheck(
      driverFor({ agent: 'Neo4j/2026.09.0', gdsVersion: '2026.09.0' }),
      'bolt://127.0.0.1:7687',
    );

    expect(result).toMatchObject({ ok: true, warn: true });
    expect(result.detail).toContain('outside the verified pairings');
  });

  it('fails a mismatched pair, which is where a procedure signature moves', async () => {
    const result = await graphPairingCheck(
      driverFor({ agent: 'Neo4j/2026.08.1', gdsVersion: '2026.07.0' }),
      'bolt://127.0.0.1:7687',
    );

    expect(result).toMatchObject({ ok: false });
    expect(result.detail).toContain('MISMATCHED');
  });

  it('fails a server with no GDS, printing the steps and the plugins dir it read', async () => {
    const result = await graphPairingCheck(
      driverFor({
        agent: 'Neo4j/2026.07.1',
        pluginsDir: '/opt/homebrew/opt/neo4j/libexec/plugins',
      }),
      'bolt://127.0.0.1:7687',
    );

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('graph-data-science is not installed');
    // The remedy, in the message, with the directory read off the server rather than from a manual.
    expect(result.detail).toContain('/opt/homebrew/opt/neo4j/libexec/plugins');
    expect(result.detail).toContain('dbms.security.procedures.unrestricted=gds.*');
    expect(result.detail).toContain('dbms.security.procedures.allowlist=gds.*');
  });
});

describe('the store-pairing check', () => {
  it('passes a paired substrate and warns on an empty machine', () => {
    expect(storePairingDetail('paired', DEFAULTS)).toMatchObject({ ok: true });
    expect(storePairingDetail('fresh', DEFAULTS)).toMatchObject({ ok: true, warn: true });
  });

  it('fails a half reset with both drops, named for the profile that owns the stores', () => {
    const docker = storePairingDetail('graph-without-database', DEFAULTS);
    expect(docker.ok).toBe(false);
    expect(docker.detail).toContain('docker volume rm');

    const native = storePairingDetail('database-without-graph', NATIVE);
    expect(native.ok).toBe(false);
    expect(native.detail).toContain('rm -rf /home/x/.aion');
  });
});

describe('the ollama runtime check', () => {
  it('reports the version and both tuning flags when the daemon carries them', () => {
    const result = ollamaRuntimeCheck({
      version: '0.33.2',
      daemonEnv: 'PATH=/usr/bin OLLAMA_FLASH_ATTENTION=1 OLLAMA_KV_CACHE_TYPE=q8_0 HOME=/x',
    });

    expect(result).toMatchObject({ ok: true });
    expect(result.warn).toBeUndefined();
    expect(result.detail).toContain('ollama 0.33.2');
    expect(result.detail).toContain('OLLAMA_FLASH_ATTENTION=1');
    expect(result.detail).toContain('OLLAMA_KV_CACHE_TYPE=q8_0');
  });

  it('warns when an upgrade or a service restart dropped one of them', () => {
    const result = ollamaRuntimeCheck({
      version: '0.33.2',
      daemonEnv: 'PATH=/usr/bin OLLAMA_FLASH_ATTENTION=1',
    });

    expect(result).toMatchObject({ ok: true, warn: true });
    expect(result.detail).toContain('OLLAMA_KV_CACHE_TYPE unset');
    // The one that is still set is reported too: a warning that hides the state is a worse read.
    expect(result.detail).toContain('OLLAMA_FLASH_ATTENTION=1');
  });

  it('reads an empty value as unset, which is what an exported-but-blank variable is', () => {
    expect(
      ollamaRuntimeCheck({ version: '0.33.2', daemonEnv: 'OLLAMA_FLASH_ATTENTION= X=1' }).warn,
    ).toBe(true);
  });

  it('prints the manual command where the process table cannot be read from here', () => {
    // Inside the container the daemon is on another machine as far as the kernel is concerned,
    // and the flags are process environment: no endpoint reports them.
    const result = ollamaRuntimeCheck({ version: '0.24.0', daemonEnv: undefined });

    expect(result).toMatchObject({ ok: true });
    expect(result.warn).toBeUndefined();
    expect(result.detail).toContain(OLLAMA_ENV_PROBE);
  });
});
