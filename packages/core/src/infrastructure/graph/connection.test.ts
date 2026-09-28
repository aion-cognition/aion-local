import { describe, expect, it, vi } from 'vitest';

import { GraphConnection } from './connection.js';

const driverFactory = vi.fn((..._args: unknown[]): Record<string, unknown> => ({ close: vi.fn() }));

vi.mock('neo4j-driver', () => ({
  default: {
    driver: (...args: unknown[]) => driverFactory(...(args as [])),
    auth: { basic: (user: string, password: string) => ({ user, password }) },
    routing: { READ: 'READ', WRITE: 'WRITE' },
  },
}));

/**
 * The driver's defaults outlast the MCP client's 60s request timeout, which is how a call
 * against a dead Neo4j used to reach the caller as a client-side timeout with the server's
 * own named error lost. The regression this guards is the config object going missing or a
 * value drifting back above the boundary.
 */
describe('the driver timeouts a tool call inherits', () => {
  it('bounds connect, acquisition, and transaction retry well inside the MCP request timeout', () => {
    driverFactory.mockClear();

    new GraphConnection({ uri: 'bolt://neo4j:7687', password: 'secret' });

    const options = driverFactory.mock.calls[0]?.[2] as Record<string, number> | undefined;
    expect(options).toEqual({
      connectionTimeout: 5000,
      connectionAcquisitionTimeout: 10_000,
      maxTransactionRetryTime: 10_000,
    });
    for (const value of Object.values(options ?? {})) {
      expect(value).toBeLessThan(60_000);
    }
  });

  it('keeps acquisition longer than a single connect attempt, which the driver requires', () => {
    driverFactory.mockClear();

    new GraphConnection({ uri: 'bolt://neo4j:7687', password: 'secret' });

    const options = driverFactory.mock.calls[0]?.[2] as Record<string, number>;
    expect(options.connectionAcquisitionTimeout).toBeGreaterThan(options.connectionTimeout ?? 0);
  });
});

/**
 * A driver left open keeps the event loop alive, so a command that probes and then returns
 * prints its last line and never exits. The probe owns its driver and closes it on both answers.
 */
describe('a one-shot probe', () => {
  const endpoint = { uri: 'bolt://127.0.0.1:7687', password: 'secret' };

  it('closes its driver after a server that answers', async () => {
    const close = vi.fn(async () => undefined);
    driverFactory.mockImplementationOnce(() => ({
      getServerInfo: async () => ({
        address: '127.0.0.1:7687',
        protocolVersion: 5.8,
        agent: 'Neo4j/2026.01.0',
      }),
      close,
    }));

    await expect(GraphConnection.probe(endpoint)).resolves.toMatchObject({ reachable: true });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('closes its driver after a server that refuses, and still returns the refusal', async () => {
    const close = vi.fn(async () => undefined);
    driverFactory.mockImplementationOnce(() => ({
      getServerInfo: async () => {
        throw new Error('The client is unauthorized due to authentication failure.');
      },
      close,
    }));

    await expect(GraphConnection.probe(endpoint)).resolves.toEqual({
      reachable: false,
      error: 'The client is unauthorized due to authentication failure.',
    });
    expect(close).toHaveBeenCalledTimes(1);
  });
});
