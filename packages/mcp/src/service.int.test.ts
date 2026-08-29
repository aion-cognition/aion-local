import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bootstrapBackbone,
  ensureGraphSession,
  fetchAdjacency,
  getLastPack,
  openSqliteHandle,
  readMemberName,
  runGraphMigrations,
  withCurrency,
  type SqliteHandle,
} from '@aion/core';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '@aion/core/infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { MemoryPackSchema, ReflectionOutputSchema } from '@aion/protocol';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapService, type AionService } from './bootstrap.js';
import { HEALTH_PATH, MCP_PATH } from './http.js';

/**
 * The whole surface at once: the real assembly from `bootstrapService`, a throwaway Neo4j,
 * a temp SQLite, and the host's live Ollama, driven by the MCP SDK's own client over a
 * loopback socket. Two clients connect at the same time and each stores then recalls, which
 * puts the claim under test: one service, one substrate, one memory session per connected
 * client.
 */

const MEMBER_NAME = 'Ryan Huber';
const EMBED_DIMENSION = 768;

const OBSERVATION_A = 'we picked webhooks for the ingestion service because polling was too slow';
const OBSERVATION_B = 'the standup moved to nine thirty on tuesdays';
const QUERY_A = 'why did we pick webhooks for ingestion';
const QUERY_B = 'when is standup';

type Connected = {
  readonly client: Client;
  readonly transport: StreamableHTTPClientTransport;
};

type Exchange = {
  readonly sessionId: string;
  readonly episodeId: string;
  readonly pack: unknown;
  readonly ack: unknown;
};

let harness: Neo4jHarness;
let dir: string;
let db: SqliteHandle;
let started: AionService;
let url: URL;
let memberId: string;
let workspaceId: string;
let exchangeA: Exchange;
let exchangeB: Exchange;

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => {
    probe.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => {
    probe.close(() => {
      resolve();
    });
  });
  return port;
}

async function open(): Promise<Connected> {
  const client = new Client({ name: 'aion-int-test', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(url);
  await client.connect(transport);
  return { client, transport };
}

/** One agent session's whole loop: store an experience, then ask for it back. */
async function storeThenRecall(observation: string, query: string): Promise<Exchange> {
  const { client, transport } = await open();
  try {
    const ack = await client.callTool({
      name: 'reflection',
      arguments: { observations: [observation] },
    });
    const stored = ReflectionOutputSchema.parse(ack.structuredContent);
    const recalled = await client.callTool({ name: 'recall', arguments: { query } });
    const sessionId = transport.sessionId;
    if (sessionId === undefined) {
      throw new Error('client transport never received a session id');
    }
    return { sessionId, episodeId: stored.episode_id, pack: recalled.structuredContent, ack };
  } finally {
    await client.close();
  }
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dir = mkdtempSync(join(tmpdir(), 'aion-mcp-int-'));
  db = openSqliteHandle({ filePath: join(dir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  const backbone = await bootstrapBackbone(harness.driver, { memberName: MEMBER_NAME });
  memberId = backbone.member.id;
  workspaceId = backbone.workspace.id;

  const port = await freePort();
  started = await bootstrapService({
    AION_NEO4J_URI: harness.uri,
    AION_NEO4J_PASSWORD: harness.password,
    AION_OLLAMA_URL: 'http://127.0.0.1:11434',
    AION_SQLITE_PATH: join(dir, 'aion.sqlite'),
    AION_LOG_FILE: join(dir, 'aion.jsonl'),
    AION_LOG_LEVEL: 'debug',
    AION_MCP_PORT: String(port),
  });
  await started.service.listen();
  url = new URL(`http://127.0.0.1:${String(started.service.port)}${MCP_PATH}`);

  [exchangeA, exchangeB] = await Promise.all([
    storeThenRecall(OBSERVATION_A, QUERY_A),
    storeThenRecall(OBSERVATION_B, QUERY_B),
  ]);
}, 300_000);

afterAll(async () => {
  await started.close();
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('two concurrent client sessions', () => {
  it('gives each client its own transport session and its own Session node', async () => {
    expect(exchangeA.sessionId).not.toBe(exchangeB.sessionId);

    for (const sessionId of [exchangeA.sessionId, exchangeB.sessionId]) {
      const resolved = await ensureGraphSession(harness.driver, { sessionId, memberId, workspaceId });
      expect(resolved.created).toBe(false);
    }
  });

  it('chains the two sessions for the one member instead of forking or cycling', async () => {
    const a = await ensureGraphSession(harness.driver, {
      sessionId: exchangeA.sessionId,
      memberId,
      workspaceId,
    });
    const b = await ensureGraphSession(harness.driver, {
      sessionId: exchangeB.sessionId,
      memberId,
      workspaceId,
    });

    // Whichever won the race is the head of the chain; the other is the member's first session.
    const links = [
      { id: exchangeA.sessionId, follows: a.follows },
      { id: exchangeB.sessionId, follows: b.follows },
    ].filter((link) => link.follows !== undefined);

    expect(links).toHaveLength(1);
    const head = links[0];
    expect(head?.follows).toBe(head?.id === exchangeA.sessionId ? exchangeB.sessionId : exchangeA.sessionId);
  });

  it('links each Session node to the backbone and to the episode it stored', async () => {
    const neighbours = await fetchAdjacency(harness.driver, {
      frontier: [exchangeA.sessionId, exchangeB.sessionId],
      visited: [],
      mode: withCurrency(),
    });

    for (const exchange of [exchangeA, exchangeB]) {
      const types = neighbours
        .filter((neighbour) => neighbour.sourceId === exchange.sessionId)
        .map((neighbour) => neighbour.relationshipType);
      expect(types).toContain('INITIATED_BY');
      expect(types).toContain('WITHIN_WORKSPACE');
      expect(types).toContain('PARTICIPATES_IN');
    }
  });

  it('does not rename the member it found', async () => {
    expect(await readMemberName(harness.driver)).toBe(MEMBER_NAME);
  });
});

describe('tool results over the wire', () => {
  it('acks each reflection with its episode id and a one-line summary', () => {
    for (const exchange of [exchangeA, exchangeB]) {
      const ack = exchange.ack as { content: ReadonlyArray<{ type: string; text: string }> };
      expect(ack.content[0]?.type).toBe('text');
      // Not an exact match: the two pushes race, so which one's queue insert lands first
      // (and therefore whether the ack names a `pending_ahead` clause) is nondeterministic.
      expect(ack.content[0]?.text).toContain(
        `Stored episode ${exchange.episodeId}; queued for reflection (interactive lane).`,
      );
    }
    expect(exchangeA.episodeId).not.toBe(exchangeB.episodeId);
  });

  it('returns a pack that parses as a MemoryPack for both clients', () => {
    for (const exchange of [exchangeA, exchangeB]) {
      const parsed = MemoryPackSchema.safeParse(exchange.pack);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.metadata.cues.length).toBeGreaterThan(0);
        expect(parsed.data.metadata.token_estimate).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('persists each pack under the session that asked for it', () => {
    expect(getLastPack(db, exchangeA.sessionId)?.pack).toEqual(exchangeA.pack);
    expect(getLastPack(db, exchangeB.sessionId)?.pack).toEqual(exchangeB.pack);
    expect(getLastPack(db, exchangeA.sessionId)?.pack).not.toEqual(exchangeB.pack);
  });
});

describe('failure handling', () => {
  it('answers a malformed payload with invalid params and keeps serving the session', async () => {
    const { client } = await open();
    try {
      const rejected = await client
        .callTool({ name: 'recall', arguments: { context: { summary: 'no query here' } } })
        .catch((err: unknown) => err);

      expect((rejected as { code?: number }).code).toBe(ErrorCode.InvalidParams);
      expect((rejected as { message?: string }).message ?? '').toContain('query');

      const after = await client.callTool({ name: 'recall', arguments: { query: QUERY_A } });
      expect(MemoryPackSchema.safeParse(after.structuredContent).success).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('answers the liveness probe the CLI starts the service against', async () => {
    const response = await fetch(new URL(HEALTH_PATH, url));
    expect(response.status).toBe(200);
    expect(((await response.json()) as { status: string }).status).toBe('ok');
  });
});
