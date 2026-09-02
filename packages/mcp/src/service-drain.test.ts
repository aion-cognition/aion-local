import { assemblePack, openLogger, type BucketCaps, type Logger } from '@aion/core';
import { admittedAll } from '@aion/core/recall/domain/test-support/admission.fixture.js';
import { MemoryPackSchema, type Cue, type MemoryPack, type StageTimingsMs } from '@aion/protocol';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MCP_PATH } from './http.js';
import { AionMcpService } from './service.js';
import type { ToolBackend } from './tools.js';

/**
 * The drain half of graceful shutdown, split out of `service.test.ts` to keep that file under
 * the repo's line cap. Each case opens its own service on its own port, so it needs no fixture
 * from that file beyond the logger.
 */

const CAPS: BucketCaps = { facts: 15, episodes: 5, narratives: 5, preferences: 3, resonant: 5 };
const CUES: readonly Cue[] = [{ text: 'webhooks', source: 'query', weight: 3 }];
const TIMINGS: StageTimingsMs = { embed: 1, cues: 2, seeds: 3, activation: 4, fusion: 5 };

function emptyPack(): MemoryPack {
  return assemblePack({
    items: [],
    admission: admittedAll(0),
    caps: CAPS,
    tokenBudget: 1200,
    cues: CUES,
    timings: TIMINGS,
  });
}

let dir: string;
let logger: Logger;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-mcp-service-drain-'));
  logger = openLogger({ filePath: join(dir, 'aion.jsonl'), level: 'debug' });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('graceful shutdown', () => {
  /**
   * Its own service on its own port: closing is terminal, so this cannot share the one the
   * rest of the file connects to.
   */
  async function openDrainable(): Promise<{
    readonly service: AionMcpService;
    readonly client: Client;
    readonly release: () => void;
    readonly started: Promise<void>;
  }> {
    let release = (): void => undefined;
    let started = (): void => undefined;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const gated: ToolBackend = {
      recall: async () => {
        started();
        await gate;
        return emptyPack();
      },
      reflection: () =>
        Promise.resolve({ episode_id: 'episode-1', queued: true, lane: 'interactive' } as const),
    };

    const drainable = new AionMcpService({
      backend: gated,
      logger,
      host: '127.0.0.1',
      port: 0,
      // Short enough that the deadline case does not stall the suite, long enough that the
      // two cases which do finish are never racing it.
      drainTimeoutMs: 1500,
    });
    const port = await drainable.listen();
    const client = new Client({ name: 'aion-drain-test', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${String(port)}${MCP_PATH}`)),
    );
    return { service: drainable, client, release, started: startedPromise };
  }

  it('answers a tool call that was already running when shutdown began', async () => {
    const { service: drainable, client, release, started } = await openDrainable();

    const call = client.callTool({ name: 'recall', arguments: { query: 'in flight' } });
    await started;
    expect(drainable.inFlightCount).toBe(1);

    const closing = drainable.close();
    release();

    const result = (await call) as { structuredContent?: MemoryPack };
    expect(MemoryPackSchema.parse(result.structuredContent)).toBeDefined();
    await closing;
    expect(drainable.inFlightCount).toBe(0);
  });

  it('refuses a tool call that arrives after shutdown began', async () => {
    const { service: drainable, client, release, started } = await openDrainable();

    const inFlight = client.callTool({ name: 'recall', arguments: { query: 'in flight' } });
    await started;
    const closing = drainable.close();

    await expect(
      client.callTool({ name: 'reflection', arguments: { observations: ['too late'] } }),
    ).rejects.toThrow(/shutting down/);

    release();
    await inFlight;
    await closing;
  });

  it('gives up at the drain deadline rather than hanging the shutdown', async () => {
    const { service: drainable, client, release, started } = await openDrainable();

    // Never released before the deadline. Its socket dies with the service and the client
    // learns nothing, which is exactly the outcome the drain exists to make rare.
    void client
      .callTool({ name: 'recall', arguments: { query: 'never finishes' } })
      .catch(() => undefined);
    await started;

    const begun = Date.now();
    await drainable.close();
    const elapsed = Date.now() - begun;

    expect(elapsed).toBeGreaterThanOrEqual(1000);
    expect(elapsed).toBeLessThan(10_000);

    release();
  }, 30_000);
});
