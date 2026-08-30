import { assemblePack, openLogger, type BucketCaps, type Logger } from '@aion/core';
import { admittedAll } from '@aion/core/recall/domain/test-support/admission.fixture.js';
import type { MemoryPack } from '@aion/protocol';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MCP_PATH } from './http.js';
import { AionMcpService } from './service.js';
import type { ToolBackend } from './tools.js';

/**
 * The session-close boundary. What matters here is that the hook fires exactly once per
 * closed transport, carries the identity the Session node is keyed on, and cannot take the
 * service down with it.
 */

const CAPS: BucketCaps = { facts: 15, episodes: 5, narratives: 5, preferences: 3, resonant: 5 };

function emptyPack(): MemoryPack {
  return assemblePack({
    admission: admittedAll(0),
    items: [],
    caps: CAPS,
    tokenBudget: 1200,
    cues: [{ text: 'webhooks', source: 'query', weight: 3 }],
    timings: { embed: 1, cues: 2, seeds: 3, activation: 4, fusion: 5 },
  });
}

const backend: ToolBackend = {
  recall: () => Promise.resolve(emptyPack()),
  reflection: () =>
    Promise.resolve({ episode_id: 'episode-1', queued: true, lane: 'interactive' } as const),
};

let dir: string;
let logger: Logger;
let service: AionMcpService;
let url: URL;
let closed: string[];
let hook: (sessionId: string) => void;

async function open(): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const client = new Client({ name: 'aion-session-close-test', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(url);
  await client.connect(transport);
  return { client, transport };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aion-mcp-session-close-'));
  logger = openLogger({ filePath: join(dir, 'aion.jsonl'), level: 'fatal' });
  closed = [];
  hook = (sessionId) => {
    closed.push(sessionId);
  };
  service = new AionMcpService({
    backend,
    logger,
    host: '127.0.0.1',
    port: 0,
    onSessionClosed: (sessionId) => {
      hook(sessionId);
    },
  });
  const port = await service.listen();
  url = new URL(`http://127.0.0.1:${String(port)}${MCP_PATH}`);
});

afterEach(async () => {
  await service.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('session close hook', () => {
  it('fires once with the transport session id the Session node is keyed on', async () => {
    const { client, transport } = await open();
    await client.callTool({ name: 'recall', arguments: { query: 'why webhooks' } });
    const { sessionId } = transport;

    await transport.terminateSession();
    await client.close();

    expect(closed).toEqual([sessionId]);
    expect(service.sessionCount).toBe(0);
  });

  it('keeps one client’s close out of another’s session', async () => {
    const first = await open();
    const second = await open();
    const firstId = first.transport.sessionId;

    await first.transport.terminateSession();
    await first.client.close();

    expect(closed).toEqual([firstId]);
    expect(service.sessionCount).toBe(1);

    await second.client.close();
  });

  it('survives a hook that throws', async () => {
    hook = () => {
      throw new Error('narrative queue is full');
    };

    const { client, transport } = await open();
    await transport.terminateSession();
    await client.close();

    expect(service.sessionCount).toBe(0);

    const later = await open();
    const answered = await later.client.callTool({
      name: 'recall',
      arguments: { query: 'still up' },
    });
    expect(answered.isError ?? false).toBe(false);
    await later.client.close();
  });
});
