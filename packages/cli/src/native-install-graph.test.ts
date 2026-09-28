import { DEFAULTS, type Config } from '@aion/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NativeSetupError, type HostActions } from './host-actions.js';
import { provisionNativeGraph } from './native-install.js';

/**
 * The graph half of the native install, with the Neo4j driver faked so the test decides what the
 * server answers and counts the drivers left open. One still open when init returns keeps the
 * event loop alive, and `aion init --install native` prints that it is ready and never exits.
 */

const server = vi.hoisted(() => ({
  refusal: undefined as string | undefined,
  opened: 0,
  closed: 0,
}));

vi.mock('neo4j-driver', async (importOriginal) => {
  const actual = await importOriginal<{ default: Record<string, unknown> }>();
  return {
    ...actual,
    default: {
      ...actual.default,
      driver: () => {
        server.opened += 1;
        return {
          getServerInfo: async () => {
            if (server.refusal !== undefined) {
              throw new Error(server.refusal);
            }
            return { address: '127.0.0.1:7687', protocolVersion: 5.8, agent: 'Neo4j/2026.01.0' };
          },
          // The one query the pairing check runs against a server that answers: the plugin version.
          executeQuery: async () => ({ records: [{ get: () => '2026.01.0' }] }),
          close: async () => {
            server.closed += 1;
          },
        };
      },
    },
  };
});

/** No Homebrew and no NEO4J_HOME, so a refusal names no layout and nothing is installed. */
const noHost: HostActions = {
  run: () => Promise.resolve({ ok: false, stdout: '', stderr: 'brew: command not found' }),
  fetch: () => Promise.reject(new Error('no fetch in this path')),
};

const config: Config = {
  ...DEFAULTS,
  neo4j: { ...DEFAULTS.neo4j, uri: 'bolt://127.0.0.1:7687' },
};

beforeEach(() => {
  server.refusal = undefined;
  server.opened = 0;
  server.closed = 0;
});

describe('probing the graph a native install runs on', () => {
  it('closes every driver it opened when the server is already running', async () => {
    const lines: string[] = [];

    await expect(
      provisionNativeGraph(config, 'secret', (line) => lines.push(line), noHost, {}),
    ).resolves.toBeUndefined();

    expect(lines).toContain('  already running');
    // The probe and the pairing read each open one.
    expect(server.opened).toBe(2);
    expect(server.closed).toBe(server.opened);
  });

  it('closes the probe before refusing a password the server rejects', async () => {
    server.refusal = 'The client is unauthorized due to authentication failure.';

    await expect(
      provisionNativeGraph(config, 'wrong', () => undefined, noHost, {}),
    ).rejects.toBeInstanceOf(NativeSetupError);

    expect(server.opened).toBe(1);
    expect(server.closed).toBe(1);
  });
});
