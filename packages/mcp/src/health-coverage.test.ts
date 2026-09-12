import { openLogger, type CoverageStateReport, type Logger } from '@aion/core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { refusingArchiveBackend } from './archive-backend.fixture.js';
import { HEALTH_PATH } from './http.js';
import { AionMcpService } from './service.js';
import type { ToolBackend } from './tools.js';

/**
 * The coverage half of `/health`, in its own file for the same reason the plasticity half is:
 * `service.test.ts` stays under the line cap. What these assert is that a probe can tell a
 * substrate serving history from one serving none, and neither from one where eviction is armed.
 */

const backend: ToolBackend = {
  recall: () => Promise.reject(new Error('not exercised in this file')),
  reflection: () => Promise.reject(new Error('not exercised in this file')),
  ...refusingArchiveBackend(),
};

let dir: string;
let logger: Logger;
let service: AionMcpService | undefined;

afterEach(async () => {
  const closing = service;
  service = undefined;
  await closing?.close();
  rmSync(dir, { recursive: true, force: true });
});

async function serve(coverage?: () => CoverageStateReport): Promise<URL> {
  dir = mkdtempSync(join(tmpdir(), 'aion-mcp-health-coverage-'));
  logger = openLogger({ filePath: join(dir, 'aion.jsonl'), level: 'debug' });
  service = new AionMcpService({
    backend,
    logger,
    host: '127.0.0.1',
    port: 0,
    ...(coverage === undefined ? {} : { coverage }),
  });
  const port = await service.listen();
  return new URL(HEALTH_PATH, `http://127.0.0.1:${String(port)}`);
}

async function body(url: URL): Promise<Record<string, unknown>> {
  return (await (await fetch(url)).json()) as Record<string, unknown>;
}

describe('health, the coverage fields', () => {
  it('omits every coverage field when no dependency was supplied', async () => {
    const read = await body(await serve());

    expect(read.status).toBe('ok');
    expect(read.coverage_state).toBeUndefined();
    expect(read.eviction_gate).toBeUndefined();
  });

  it('reports an active contract with the horizon its answers may claim', async () => {
    const url = await serve(() => ({
      coverageState: 'active',
      historySince: '2026-09-11T06:00:00.000Z',
      coverageEpoch: 'epoch-1',
      evictionGate: 'unarmed',
      evictionCompatibilityRevision: 0,
    }));

    expect(await body(url)).toMatchObject({
      status: 'ok',
      coverage_state: 'active',
      coverage_history_since: '2026-09-11T06:00:00.000Z',
      coverage_epoch: 'epoch-1',
    });
  });

  it('reports a preparing contract as ok liveness with no horizon', async () => {
    const url = await serve(() => ({
      coverageState: 'preparing',
      historySince: null,
      coverageEpoch: 'epoch-1',
      evictionGate: 'unarmed',
      evictionCompatibilityRevision: 0,
    }));

    expect(await body(url)).toMatchObject({
      status: 'ok',
      coverage_state: 'preparing',
      coverage_history_since: null,
    });
  });

  it('carries the eviction fence as its own keys, not as a coverage state', async () => {
    const url = await serve(() => ({
      coverageState: 'active',
      historySince: '2026-09-11T06:00:00.000Z',
      coverageEpoch: 'epoch-1',
      evictionGate: 'armed',
      evictionCompatibilityRevision: 4,
    }));

    expect(await body(url)).toMatchObject({
      coverage_state: 'active',
      eviction_gate: 'armed',
      eviction_compatibility_revision: 4,
    });
  });
});
