import { describe, expect, it, vi } from 'vitest';

import { GraphConnection } from './connection.js';

const driverFactory = vi.fn((..._args: unknown[]) => ({ close: vi.fn() }));

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
