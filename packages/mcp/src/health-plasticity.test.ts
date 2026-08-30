import { openLogger, type Logger, type PlasticityCounters } from '@aion/core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { HEALTH_PATH } from './http.js';
import { AionMcpService } from './service.js';
import type { ToolBackend } from './tools.js';

/**
 * The plasticity half of `/health`, split out of `service.test.ts` to keep that file under the
 * repo's line cap. `service.test.ts`'s own health tests cover the queue-lag fields beside these.
 */

const backend: ToolBackend = {
  recall: () => Promise.reject(new Error('not exercised in this file')),
  reflection: () => Promise.reject(new Error('not exercised in this file')),
};

let dir: string;
let logger: Logger;
let service: AionMcpService | undefined;

afterEach(async () => {
  // Clear the module-level handle before awaiting the close, not after: a later `serve()` call
  // reassigning `service` mid-await would otherwise be stomped by this hook resuming last.
  const closing = service;
  service = undefined;
  await closing?.close();
  rmSync(dir, { recursive: true, force: true });
});

async function serve(plasticity?: () => PlasticityCounters): Promise<URL> {
  dir = mkdtempSync(join(tmpdir(), 'aion-mcp-health-plasticity-'));
  logger = openLogger({ filePath: join(dir, 'aion.jsonl'), level: 'debug' });
  service = new AionMcpService({
    backend,
    logger,
    host: '127.0.0.1',
    port: 0,
    ...(plasticity === undefined ? {} : { plasticity }),
  });
  const port = await service.listen();
  return new URL(HEALTH_PATH, `http://127.0.0.1:${String(port)}`);
}

describe('health, the plasticity fields', () => {
  it('omits every plasticity field when no dependency was supplied', async () => {
    const url = await serve();

    const body = (await (await fetch(url)).json()) as Record<string, unknown>;

    expect(body.reinforcement_signals_applied).toBeUndefined();
    expect(body.decay_edges_scanned).toBeUndefined();
  });

  it('surfaces reinforcement and decay counters plus the reinforcement queue depth', async () => {
    const url = await serve(() => ({
      reinforcement: {
        signalsApplied: 12,
        pairsApplied: 5,
        edgesUpdated: 4,
        lastRunAt: '2026-08-27T00:00:00.000Z',
      },
      reinforcementDropped: 0,
      reinforcementQueueDepth: 3,
      decay: { edgesScanned: 9, edgesDecayed: 6, lastRunAt: '2026-08-27T00:05:00.000Z' },
    }));

    const body = (await (await fetch(url)).json()) as Record<string, unknown>;

    expect(body.reinforcement_signals_applied).toBe(12);
    expect(body.reinforcement_pairs_applied).toBe(5);
    expect(body.reinforcement_edges_updated).toBe(4);
    expect(body.reinforcement_last_run_at).toBe('2026-08-27T00:00:00.000Z');
    expect(body.reinforcement_queue_depth).toBe(3);
    expect(body.decay_edges_scanned).toBe(9);
    expect(body.decay_edges_decayed).toBe(6);
    expect(body.decay_last_run_at).toBe('2026-08-27T00:05:00.000Z');
    // Not repeated: it is already one of the queue-lag fields, read from the same counter.
    expect(Object.keys(body).filter((key) => key === 'reinforcement_dropped')).toHaveLength(0);
  });

  it('reports null rather than omitting last-run timestamps before either operation has run', async () => {
    const url = await serve(() => ({
      reinforcement: { signalsApplied: 0, pairsApplied: 0, edgesUpdated: 0 },
      reinforcementDropped: 0,
      reinforcementQueueDepth: 0,
      decay: { edgesScanned: 0, edgesDecayed: 0 },
    }));

    const body = (await (await fetch(url)).json()) as Record<string, unknown>;

    expect(body.reinforcement_last_run_at).toBeNull();
    expect(body.decay_last_run_at).toBeNull();
  });
});
