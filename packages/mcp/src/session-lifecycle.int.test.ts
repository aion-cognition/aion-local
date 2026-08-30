import {
  bootstrapBackbone,
  CueCache,
  DEFAULTS,
  findSessionNarratives,
  getLastPack,
  handleRecall,
  handleReflection,
  LaneAssigner,
  openLogger,
  openSqliteHandle,
  ReflectionDispatch,
  runGraphMigrations,
  SessionManager,
  SessionNarrativeCloser,
  type Config,
  type Logger,
  type Provider,
  type RecallDeps,
  type ReflectionIntakeDeps,
  type SqliteHandle,
} from '@aion/core';
import {
  countNodesWithId,
  edgeTargetId,
} from '@aion/core/infrastructure/graph/test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '@aion/core/infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MCP_PATH } from './http.js';
import { AionMcpService } from './service.js';
import { SessionIdleSweeper } from './session-idle-sweeper.js';
import type { ToolBackend } from './tools.js';

/**
 * Both session-close triggers end to end: the transport, the graph, and the two triggers
 * together, over a real MCP client and a throwaway Neo4j. The provider is stubbed
 * (`generate` answers every schema with a narrative-shaped object, `embed` returns a fixed
 * vector) so the narrative half runs on the harness's own clock instead of a live model's.
 */

const MEMBER_NAME = 'Session Lifecycle Test';
const EMBED_DIMENSION = 8;
const IDLE_MS = 200;

const FIXED_VECTOR = [1, 0, 0, 0, 0, 0, 0, 0];

/**
 * Matches `NarrativeOutputSchema` (`{sentences: [{text, source_ids}]}`), citing the first
 * rendered source item (`S1`, always the session's own first episode; see
 * `renderNarrativeSource`) so the grounding filter keeps the sentence rather than dropping it.
 */
const provider: Provider = {
  embed: (texts) => Promise.resolve(texts.map(() => [...FIXED_VECTOR])),
  generate: () =>
    Promise.resolve({
      sentences: [{ text: 'a compressed account of the session', source_ids: ['S1'] }],
    }),
};

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let logger: Logger;
let sessions: SessionManager;
let config: Config;
let narratives: SessionNarrativeCloser;
let service: AionMcpService;
let sweeper: SessionIdleSweeper;
let url: URL;

async function open(): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const client = new Client({ name: 'aion-session-lifecycle-test', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(url);
  await client.connect(transport);
  return { client, transport };
}

async function sessionExists(sessionId: string): Promise<boolean> {
  return (await countNodesWithId(harness.driver, 'Session', sessionId)) > 0;
}

async function followsTarget(sessionId: string): Promise<string | undefined> {
  return edgeTargetId(harness.driver, 'FOLLOWS', sessionId);
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-session-lifecycle-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' });
  config = { ...DEFAULTS, models: { ...DEFAULTS.models, embedDimension: EMBED_DIMENSION } };

  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });
  const backbone = await bootstrapBackbone(harness.driver, { memberName: MEMBER_NAME });
  sessions = new SessionManager(harness.driver, {
    memberId: backbone.member.id,
    workspaceId: backbone.workspace.id,
  });

  const intake: ReflectionIntakeDeps = {
    driver: harness.driver,
    db,
    sessions,
    provider,
    dispatch: new ReflectionDispatch(),
    logger,
    entropyThreshold: config.redaction.entropyThreshold,
    lanes: new LaneAssigner(config.lanes),
    workerMaxAttempts: config.operational.workerMaxAttempts,
  };
  const recall: RecallDeps = {
    driver: harness.driver,
    db,
    sessions,
    provider,
    config,
    cueCache: new CueCache(),
    logger,
  };

  narratives = new SessionNarrativeCloser(
    { driver: harness.driver, provider, logger },
    { model: config.models.reflect },
  );

  const backend: ToolBackend = {
    recall: (args, identity) => handleRecall(recall, args, { identity }),
    reflection: (args, identity) => handleReflection(intake, args, { identity }),
  };

  service = new AionMcpService({
    backend,
    logger,
    host: '127.0.0.1',
    port: 0,
    onSessionClosed: narratives.onSessionClosed,
  });
  const port = await service.listen();
  url = new URL(`http://127.0.0.1:${String(port)}${MCP_PATH}`);
  sweeper = new SessionIdleSweeper(service, { idleMs: IDLE_MS });
}, 300_000);

afterAll(async () => {
  await service.close();
  await narratives.whenIdle();
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('lazy Session node creation', () => {
  it('leaves no Session node for a connection that never calls a tool', async () => {
    const { client, transport } = await open();
    const sessionId = transport.sessionId ?? '';
    expect(sessionId).not.toBe('');

    await transport.terminateSession();
    await client.close();

    expect(await sessionExists(sessionId)).toBe(false);
  });

  /**
   * Recall produces nothing to remember, so it mints nothing. Half the Session nodes measured
   * held zero episodes, and recall is what generated them: ~1,480 calls, each one adding an
   * edge to both structural hubs and a link to a 477-edge FOLLOWS chain. The pack is still
   * served and still recorded against the session id, which is the point: the id exists
   * without the node, because the node is keyed on the id.
   */
  it('leaves no Session node for a recall-only session, and still serves the pack', async () => {
    const { client, transport } = await open();
    await client.callTool({ name: 'recall', arguments: { query: 'anything at all' } });
    const sessionId = transport.sessionId ?? '';

    expect(await sessionExists(sessionId)).toBe(false);
    expect(getLastPack(db, sessionId)).toBeDefined();

    await transport.terminateSession();
    await client.close();
  });

  it('creates it on the first reflection, which is the first thing worth remembering', async () => {
    const { client, transport } = await open();
    await client.callTool({ name: 'recall', arguments: { query: 'still nothing stored' } });
    const sessionId = transport.sessionId ?? '';
    expect(await sessionExists(sessionId)).toBe(false);

    await client.callTool({ name: 'reflection', arguments: { observations: ['now there is'] } });

    expect(await sessionExists(sessionId)).toBe(true);

    await transport.terminateSession();
    await client.close();
  });
});

describe('FOLLOWS chain integrity across mixed empty/content sessions', () => {
  it('links content sessions to each other, skipping every probe between them', async () => {
    const probeBefore = await open();
    await probeBefore.transport.terminateSession();
    await probeBefore.client.close();

    const first = await open();
    await first.client.callTool({
      name: 'reflection',
      arguments: { observations: ['chain link A'] },
    });
    const sessionA = first.transport.sessionId ?? '';
    await first.transport.terminateSession();
    await first.client.close();

    const probeBetween = await open();
    await probeBetween.transport.terminateSession();
    await probeBetween.client.close();

    const second = await open();
    await second.client.callTool({
      name: 'reflection',
      arguments: { observations: ['chain link B'] },
    });
    const sessionB = second.transport.sessionId ?? '';
    await second.transport.terminateSession();
    await second.client.close();

    expect(await sessionExists(sessionA)).toBe(true);
    expect(await sessionExists(sessionB)).toBe(true);
    expect(await followsTarget(sessionB)).toBe(sessionA);

    for (const probe of [probeBefore, probeBetween]) {
      const probeId = probe.transport.sessionId ?? '';
      expect(await sessionExists(probeId)).toBe(false);
    }
  });
});

describe('reliable close', () => {
  it('idle expiry closes a client.close() session (no DELETE) and fires the narrative trigger', async () => {
    const { client, transport } = await open();
    await client.callTool({
      name: 'reflection',
      arguments: { observations: ['something worth narrating on close'] },
    });
    const sessionId = transport.sessionId ?? '';

    // A bare close(): the SDK client tears down its own transport without issuing the DELETE
    // the close hook depends on, so the idle sweep is the primary trigger and not the backstop.
    await client.close();
    expect(await sessionExists(sessionId)).toBe(true);

    const closed = sweeper.sweepOnce(new Date(Date.now() + IDLE_MS + 50));
    expect(closed).toContain(sessionId);

    await narratives.whenIdle();
    const written = await findSessionNarratives(harness.driver, sessionId);
    expect(written.length).toBeGreaterThan(0);
  }, 60_000);

  it('answers a late call on an idle-expired session with the clean unknown-session error', async () => {
    const { client, transport } = await open();
    await client.callTool({
      name: 'reflection',
      arguments: { observations: ['about to go quiet'] },
    });
    const sessionId = transport.sessionId ?? '';

    sweeper.sweepOnce(new Date(Date.now() + IDLE_MS + 50));

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
    });

    expect(response.status).toBe(404);
    await client.close().catch(() => undefined);
  });
});
