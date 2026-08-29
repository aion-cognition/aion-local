import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assemblePack, openLogger, type BucketCaps, type Logger } from '@aion/core';
import { admittedAll } from '@aion/core/recall/domain/test-support/admission.fixture.js';
import { MemoryPackSchema, type Cue, type MemoryPack, type StageTimingsMs } from '@aion/protocol';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { USAGE_PROTOCOL } from './descriptions.js';
import { HEALTH_PATH, MCP_PATH } from './http.js';
import { AionMcpService } from './service.js';
import type { ToolBackend } from './tools.js';

/**
 * The transport surface with the substrate stubbed out: what this proves is session
 * multiplexing and error mapping over a real socket, not retrieval. The live substrate runs
 * in `service.int.test.ts`.
 */

const CAPS: BucketCaps = { facts: 15, episodes: 5, narratives: 5, preferences: 3, resonant: 5 };
const CUES: readonly Cue[] = [{ text: 'webhooks', source: 'query', weight: 3 }];
const TIMINGS: StageTimingsMs = { embed: 1, cues: 2, seeds: 3, activation: 4, fusion: 5 };

type Call = { readonly tool: string; readonly identity: string };

const calls: Call[] = [];

function emptyPack(): MemoryPack {
  return assemblePack({ items: [], admission: admittedAll(0), caps: CAPS, tokenBudget: 1200, cues: CUES, timings: TIMINGS });
}

const backend: ToolBackend = {
  recall: (args, identity) => {
    calls.push({ tool: 'recall', identity });
    const payload = args as { query?: string };
    if (payload.query === 'boom') {
      return Promise.reject(new TypeError('driver exploded'));
    }
    return Promise.resolve(emptyPack());
  },
  reflection: (_args, identity) => {
    calls.push({ tool: 'reflection', identity });
    return Promise.resolve({ episode_id: 'episode-1', queued: true, lane: 'interactive' } as const);
  },
};

let dir: string;
let logger: Logger;
let service: AionMcpService;
let url: URL;

type Connected = {
  readonly client: Client;
  readonly transport: StreamableHTTPClientTransport;
};

async function open(): Promise<Connected> {
  const client = new Client({ name: 'aion-service-test', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(url);
  await client.connect(transport);
  return { client, transport };
}

async function connect(): Promise<Client> {
  const { client } = await open();
  return client;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aion-mcp-service-'));
  logger = openLogger({ filePath: join(dir, 'aion.jsonl'), level: 'debug' });
  service = new AionMcpService({ backend, logger, host: '127.0.0.1', port: 0 });
  const port = await service.listen();
  url = new URL(`http://127.0.0.1:${String(port)}${MCP_PATH}`);
});

afterAll(async () => {
  await service.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('tool discovery', () => {
  it('lists both tools with their when-to-invoke descriptions', async () => {
    const client = await connect();
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual(['recall', 'reflection']);
      expect(listed.tools[0]?.description ?? '').toContain('Call recall:');
    } finally {
      await client.close();
    }
  });

  it('ships the usage protocol as server instructions', async () => {
    const client = await connect();
    try {
      expect(client.getInstructions()).toBe(USAGE_PROTOCOL);
    } finally {
      await client.close();
    }
  });
});

describe('session multiplexing', () => {
  it('gives each connected client its own identity and keeps it stable across calls', async () => {
    calls.length = 0;
    const before = service.sessionCount;
    const first = await open();
    const second = await open();
    try {
      await first.client.callTool({ name: 'recall', arguments: { query: 'why webhooks' } });
      await second.client.callTool({ name: 'reflection', arguments: { observations: ['webhooks won'] } });
      await first.client.callTool({ name: 'reflection', arguments: { observations: ['still webhooks'] } });

      const firstIdentity = calls[0]?.identity;
      const secondIdentity = calls[1]?.identity;
      expect(firstIdentity).toBeDefined();
      expect(secondIdentity).toBeDefined();
      expect(firstIdentity).not.toBe(secondIdentity);
      expect(calls[2]?.identity).toBe(firstIdentity);
      expect(service.sessionCount).toBe(before + 2);

      // The identity handed to the handlers is the transport's own session id, which is
      // what makes one Session node per connected client.
      expect(firstIdentity).toBe(first.transport.sessionId);
      expect(secondIdentity).toBe(second.transport.sessionId);
    } finally {
      await first.client.close();
      await second.client.close();
    }
  });

  it('forgets a session the client explicitly terminates', async () => {
    const before = service.sessionCount;
    const { client, transport } = await open();
    await client.callTool({ name: 'recall', arguments: { query: 'why webhooks' } });
    expect(service.sessionCount).toBe(before + 1);

    await transport.terminateSession();
    expect(service.sessionCount).toBe(before);
    await client.close();
  });
});

describe('closeIdleSessions', () => {
  /**
   * Its own service on its own port: the shared one accumulates sessions across every other
   * test in this file, and every one of them would read as idle against a synthetic cutoff.
   */
  async function openIsolated(): Promise<{
    readonly service: AionMcpService;
    readonly url: URL;
  }> {
    const isolated = new AionMcpService({ backend, logger, host: '127.0.0.1', port: 0 });
    const port = await isolated.listen();
    return { service: isolated, url: new URL(`http://127.0.0.1:${String(port)}${MCP_PATH}`) };
  }

  it('closes only the session idle past the cutoff, leaving one just touched', async () => {
    const { service: isolated, url: isolatedUrl } = await openIsolated();
    try {
      const idleClient = new Client({ name: 'aion-idle-test', version: '0.0.0' });
      const idleTransport = new StreamableHTTPClientTransport(isolatedUrl);
      await idleClient.connect(idleTransport);
      await idleClient.callTool({ name: 'recall', arguments: { query: 'about to go quiet' } });
      const idleTouchedAt = Date.now();

      // A real gap, not a synthetic one: the cutoff below sits inside it, so the two calls'
      // actual wall-clock order (not their names) is what the assertion below trusts.
      await new Promise((resolve) => setTimeout(resolve, 25));

      const activeClient = new Client({ name: 'aion-active-test', version: '0.0.0' });
      const activeTransport = new StreamableHTTPClientTransport(isolatedUrl);
      await activeClient.connect(activeTransport);
      await activeClient.callTool({ name: 'recall', arguments: { query: 'still talking' } });

      const closed = isolated.closeIdleSessions(1000, idleTouchedAt + 1000 + 10);

      expect(closed).toEqual([idleTransport.sessionId]);
      await activeClient.close();
    } finally {
      await isolated.close();
    }
  });

  it('answers a late call on an idle-expired session with the same unknown-session error a never-opened one gets', async () => {
    const { service: isolated, url: isolatedUrl } = await openIsolated();
    try {
      const client = new Client({ name: 'aion-idle-test', version: '0.0.0' });
      const transport = new StreamableHTTPClientTransport(isolatedUrl);
      await client.connect(transport);
      await client.callTool({ name: 'recall', arguments: { query: 'about to go quiet' } });
      const sessionId = transport.sessionId;
      expect(sessionId).toBeDefined();

      isolated.closeIdleSessions(0, Date.now() + 1);

      const response = await fetch(isolatedUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-session-id': sessionId ?? '',
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
      });

      expect(response.status).toBe(404);
    } finally {
      await isolated.close();
    }
  });
});

describe('results', () => {
  it('returns the rendered text and the structured pack over the wire', async () => {
    const client = await connect();
    try {
      const result = await client.callTool({ name: 'recall', arguments: { query: 'why webhooks' } });
      const content = result.content as ReadonlyArray<{ type: string; text: string }>;
      expect(content[0]?.type).toBe('text');
      expect(content[0]?.text).toContain('No memories matched this query.');
      expect(MemoryPackSchema.safeParse(result.structuredContent).success).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('acks a reflection in one line', async () => {
    const client = await connect();
    try {
      const result = await client.callTool({
        name: 'reflection',
        arguments: { observations: ['webhooks won'] },
      });
      const content = result.content as ReadonlyArray<{ text: string }>;
      expect(content[0]?.text).toBe(
        'Stored episode episode-1; queued for reflection (interactive lane).',
      );
      expect(result.structuredContent).toEqual({ episode_id: 'episode-1', queued: true, lane: 'interactive' });
    } finally {
      await client.close();
    }
  });
});

describe('errors', () => {
  it('answers an internal failure with an internal error and keeps the session usable', async () => {
    const client = await connect();
    try {
      const failure = await client
        .callTool({ name: 'recall', arguments: { query: 'boom' } })
        .catch((err: unknown) => err);
      expect((failure as { code?: number }).code).toBe(ErrorCode.InternalError);

      const after = await client.callTool({ name: 'recall', arguments: { query: 'why webhooks' } });
      expect(MemoryPackSchema.safeParse(after.structuredContent).success).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('rejects a POST that opens no session and is not an initialize', async () => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain('mcp-session-id');
  });

  it('rejects a request for a session it never opened', async () => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': 'not-a-session',
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
    });

    expect(response.status).toBe(404);
  });

  it('rejects a body that is not JSON without dropping the connection', async () => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });
});

describe('health', () => {
  it('answers a liveness probe without touching the substrate', async () => {
    const response = await fetch(new URL(HEALTH_PATH, url));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; descriptions_version: number };
    expect(body.status).toBe('ok');
    expect(body.descriptions_version).toBeGreaterThan(0);
  });

  it('404s anything that is neither the MCP endpoint nor the probe', async () => {
    const response = await fetch(new URL('/nope', url));
    expect(response.status).toBe(404);
  });

  it('omits the queue-lag fields when no queueLag dependency was supplied', async () => {
    const response = await fetch(new URL(HEALTH_PATH, url));
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['queue_depth']).toBeUndefined();
    expect(body['enrichment_lag_p95_ms']).toBeUndefined();
  });

  it('surfaces queue depth, oldest-unclaimed age, exhausted attempts, reinforcement drops, and p95 lag', async () => {
    const withLag = new AionMcpService({
      backend,
      logger,
      host: '127.0.0.1',
      port: 0,
      queueLag: () => ({
        depthByLane: { interactive: 2, bulk: 5 },
        oldestUnclaimedMs: 12_000,
        exhausted: 1,
        reinforcementDropped: 7,
        p95EnrichmentLagMs: 4_200,
      }),
    });
    const port = await withLag.listen();
    try {
      const response = await fetch(new URL(HEALTH_PATH, `http://127.0.0.1:${String(port)}`));
      const body = (await response.json()) as Record<string, unknown>;
      expect(body['queue_depth']).toEqual({ interactive: 2, bulk: 5 });
      expect(body['queue_oldest_unclaimed_ms']).toBe(12_000);
      expect(body['queue_exhausted']).toBe(1);
      expect(body['reinforcement_dropped']).toBe(7);
      expect(body['enrichment_lag_p95_ms']).toBe(4_200);
    } finally {
      await withLag.close();
    }
  });

  it('reports null rather than omitting age and p95 lag when there is nothing to measure yet', async () => {
    const empty = new AionMcpService({
      backend,
      logger,
      host: '127.0.0.1',
      port: 0,
      queueLag: () => ({
        depthByLane: { interactive: 0, bulk: 0 },
        oldestUnclaimedMs: undefined,
        exhausted: 0,
        reinforcementDropped: 0,
        p95EnrichmentLagMs: undefined,
      }),
    });
    const port = await empty.listen();
    try {
      const response = await fetch(new URL(HEALTH_PATH, `http://127.0.0.1:${String(port)}`));
      const body = (await response.json()) as Record<string, unknown>;
      expect(body['queue_oldest_unclaimed_ms']).toBeNull();
      expect(body['enrichment_lag_p95_ms']).toBeNull();
    } finally {
      await empty.close();
    }
  });
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
      reflection: () => Promise.resolve({ episode_id: 'episode-1', queued: true, lane: 'interactive' } as const),
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
