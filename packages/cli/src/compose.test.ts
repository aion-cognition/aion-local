import { describe, expect, it } from 'vitest';

import {
  composeRunner,
  ComposeCommandError,
  mcpBaseUrl,
  McpServiceNotReadyError,
  startService,
  waitForMcpHealth,
  type ComposeRunner,
} from './compose.js';

describe('mcpBaseUrl', () => {
  it('addresses the host loopback outside a container (the test process is not dockerized)', () => {
    expect(mcpBaseUrl(8765)).toBe('http://127.0.0.1:8765');
  });
});

describe('startService', () => {
  it('brings up exactly the named service, detached', async () => {
    const calls: string[][] = [];
    const run: ComposeRunner = async (args) => {
      calls.push([...args]);
      return '';
    };

    await startService(run, 'neo4j');

    expect(calls).toEqual([['up', '-d', 'neo4j']]);
  });

  it('addresses a profiled service with an explicit --profile flag', async () => {
    const calls: string[][] = [];
    const run: ComposeRunner = async (args) => {
      calls.push([...args]);
      return '';
    };

    await startService(run, 'aion-mcp', 'mcp');

    expect(calls).toEqual([['--profile', 'mcp', 'up', '-d', 'aion-mcp']]);
  });
});

describe('composeRunner', () => {
  it('reports a failed compose invocation as a named error carrying the command', async () => {
    const run = composeRunner('/nonexistent-repo-for-test');

    await expect(run(['up', '-d', 'neo4j'])).rejects.toBeInstanceOf(ComposeCommandError);
  });
});

describe('waitForMcpHealth', () => {
  it('returns once the health endpoint answers ok', async () => {
    const fetchImpl = async (url: string | URL) => {
      expect(String(url)).toBe('http://127.0.0.1:8765/health');
      return new Response('{}', { status: 200 });
    };

    await expect(
      waitForMcpHealth(8765, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toBeUndefined();
  });

  it('retries past a refused connection and then succeeds', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls < 3) {
        throw new Error('ECONNREFUSED');
      }
      return new Response('{}', { status: 200 });
    };

    await waitForMcpHealth(8765, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      pollIntervalMs: 1,
    });

    expect(calls).toBe(3);
  });

  it('times out with a named error when the service never answers', async () => {
    const fetchImpl = async () => {
      throw new Error('ECONNREFUSED');
    };

    await expect(
      waitForMcpHealth(8765, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        timeoutMs: 5,
        pollIntervalMs: 1,
      }),
    ).rejects.toBeInstanceOf(McpServiceNotReadyError);
  });
});
