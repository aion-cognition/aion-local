import {
  bootstrapBackbone,
  CueCache,
  DEFAULTS,
  deleteServedItems,
  fulltextSeeds,
  handleRecall,
  handleReflection,
  LaneAssigner,
  listReinforcementSignals,
  openLogger,
  openSqliteHandle,
  purgeServedItemsIdleSince,
  readServedItems,
  RecallSideEffects,
  runGraphMigrations,
  SessionManager,
  supersede,
  vectorSeeds,
  withCurrency,
  type Config,
  type Logger,
  type Provider,
  type RecallDeps,
  type SqliteHandle,
} from '@aion/core';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '@aion/core/infrastructure/graph/test-support/neo4j-harness.fixture.js';
import type { Vector } from '@aion/core/infrastructure/providers/types.js';
import type { MemoryPack } from '@aion/protocol';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { waitFor } from './gate/gate-substrate.fixture.js';
import { MCP_PATH } from './http.js';
import { AionMcpService } from './service.js';
import { SessionIdleSweeper } from './session-idle-sweeper.js';
import type { ToolBackend } from './tools.js';

/**
 * A session is served each memory once. A per-prompt recall hook asks many times inside one
 * conversation and the top of the ranked list barely moves between calls, so without this the
 * same items are rendered into a context that is already holding them.
 *
 * Written against a substrate the real intake path produced and read through the shipped
 * pipeline. The embedding model is stubbed by topic so which items are candidates is a
 * property of the fixture rather than of a live model's judgment; nothing about the
 * subtraction itself is stubbed.
 */

const EMBED_DIMENSION = 8;
const MEMBER_NAME = 'Ryan Huber';
const WRITE_SESSION = 'dedup-int-write-session';
const IDLE_MS = 200;
const READY_MS = 30_000;

const STORED_AT = new Date('2026-06-01T10:00:00.000Z');
const RECALLED_AT = new Date('2026-06-02T09:00:00.000Z');

const QUERY = 'why did we pick webhooks for ingestion';
const CUE = 'webhooks';

const WEBHOOK_OBSERVATIONS = [
  'we picked webhooks for the ingestion service because polling was too slow',
  'the webhooks migration landed behind a flag so ingestion could roll back',
  'webhooks retry twice before the ingestion pipeline drops the delivery',
  'ingestion webhooks are signed, so a replay from another sender is rejected',
];

function axis(index: number): Vector {
  const vector = new Array<number>(EMBED_DIMENSION).fill(0);
  vector[index] = 1;
  return vector;
}

function vectorFor(text: string): Vector {
  return text.toLowerCase().includes('webhook') ? axis(0) : axis(1);
}

const provider: Provider = {
  embed: (texts) => Promise.resolve(texts.map(vectorFor)),
  generate: () => Promise.resolve({ query_cues: [CUE], summary_cues: [], recent_turn_cues: [] }),
};

function config(overrides: Partial<Config['recall']> = {}): Config {
  return {
    ...DEFAULTS,
    models: { ...DEFAULTS.models, embedDimension: EMBED_DIMENSION },
    recall: { ...DEFAULTS.recall, ...overrides },
  };
}

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let logger: Logger;
let sessions: SessionManager;
let deps: RecallDeps;
let sideEffects: RecallSideEffects;
let episodeIds: string[];

async function push(observation: string, now: Date): Promise<string> {
  const result = await handleReflection(
    {
      driver: harness.driver,
      db,
      sessions,
      provider,
      logger,
      entropyThreshold: DEFAULTS.redaction.entropyThreshold,
      lanes: new LaneAssigner(DEFAULTS.lanes),
      workerMaxAttempts: DEFAULTS.operational.workerMaxAttempts,
    },
    { observations: [observation] },
    { identity: WRITE_SESSION, now },
  );
  return result.episode_id;
}

function recall(identity: string, overrides: Partial<RecallDeps> = {}): Promise<MemoryPack> {
  return handleRecall({ ...deps, ...overrides }, { query: QUERY }, { identity, now: RECALLED_AT });
}

function episodeIdsOf(pack: MemoryPack): readonly string[] {
  return (pack.episodes ?? []).map((entry) => entry.id);
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-session-dedup-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'debug' });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  const backbone = await bootstrapBackbone(harness.driver, { memberName: MEMBER_NAME });
  sessions = new SessionManager(harness.driver, {
    memberId: backbone.member.id,
    workspaceId: backbone.workspace.id,
  });
  sideEffects = new RecallSideEffects(harness.driver, db, logger);

  deps = {
    driver: harness.driver,
    db,
    sessions,
    provider,
    config: config(),
    cueCache: new CueCache(),
    logger,
    onRecalled: sideEffects.onRecalled,
  };

  episodeIds = [];
  for (const [index, observation] of WEBHOOK_OBSERVATIONS.entries()) {
    episodeIds.push(await push(observation, new Date(STORED_AT.getTime() + index * 60_000)));
  }

  await waitFor('the vector index to cover every stored episode', READY_MS, async () => {
    const rows = await vectorSeeds(harness.driver, {
      vector: axis(0),
      limit: 20,
      mode: withCurrency(),
    });
    return rows.length >= WEBHOOK_OBSERVATIONS.length;
  });

  await waitFor('the fulltext index to cover the stored episodes', READY_MS, async () => {
    const rows = await fulltextSeeds(harness.driver, {
      query: CUE,
      limit: 20,
      mode: withCurrency(),
    });
    return rows.length >= WEBHOOK_OBSERVATIONS.length;
  });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('a second recall inside one session', () => {
  const SESSION = 'dedup-int-repeat-session';

  it('serves each memory once and says what it withheld', async () => {
    const first = await recall(SESSION);
    expect(episodeIdsOf(first).length).toBeGreaterThanOrEqual(WEBHOOK_OBSERVATIONS.length);

    const second = await recall(SESSION);

    expect(second.episodes).toBeUndefined();
    expect(second.metadata.suppressed_repeats).toBe(episodeIdsOf(first).length);
    expect(second.rendered_text).toContain('already served this session, unchanged');
    expect(second.rendered_text).toContain(
      'This session already holds every memory this query matched.',
    );

    // The measurement this exists for, printed rather than only asserted: run the file with
    // --reporter=verbose to read it.
    console.log(
      `token_estimate first serve ${String(first.metadata.token_estimate)}, ` +
        `second serve ${String(second.metadata.token_estimate)}`,
    );
    expect(second.metadata.token_estimate).toBeLessThan(first.metadata.token_estimate);
  });

  it('leaves a different session the full pack, since it holds none of this', async () => {
    const other = await recall('dedup-int-other-session');

    // Sorted, because rank order is the query's answer and this is about which memories the
    // pack holds rather than the order it ranked them in.
    expect([...episodeIdsOf(other)].sort()).toEqual([...episodeIds].sort());
    expect(other.metadata.suppressed_repeats).toBeUndefined();
  });

  /**
   * The subtraction is a serving-layer decision and cognition never sees it: reinforcement
   * pairs the co-activated set, which is what the spread reached rather than what the pack
   * rendered. A recall that suppressed everything is still a use of every memory it found.
   */
  it('still fires the cognition side effects for the items it withheld', async () => {
    const session = 'dedup-int-reinforcement-session';
    await recall(session);
    const afterFirst = listReinforcementSignals(db).length;
    expect(afterFirst).toBeGreaterThan(0);

    const repeat = await recall(session);

    expect(repeat.episodes).toBeUndefined();
    expect(listReinforcementSignals(db).length).toBeGreaterThan(afterFirst);
  });

  it('offers a memory stored after the first serve, and nothing the session already has', async () => {
    const session = 'dedup-int-new-memory-session';
    const before = await recall(session);

    const added = await push(
      'webhooks now carry an ingestion trace id on every delivery',
      new Date(STORED_AT.getTime() + 60 * 60_000),
    );
    await waitFor('the vector index to cover the new episode', READY_MS, async () => {
      const rows = await vectorSeeds(harness.driver, {
        vector: axis(0),
        limit: 20,
        mode: withCurrency(),
      });
      return rows.some((row) => row.id === added);
    });

    const after = await recall(session);

    expect(episodeIdsOf(after)).toEqual([added]);
    expect(after.metadata.suppressed_repeats).toBe(episodeIdsOf(before).length);
  });
});

/**
 * A memory the substrate corrected is not the memory the session was handed, whatever its id
 * says. The fingerprint is over what the item renders as, so a close moves it and the item is
 * told again, this time carrying the lineage marker the first serve could not have had.
 */
describe('a memory that changed since it was served', () => {
  const SESSION = 'dedup-int-supersession-session';

  it('is served again in full while the unchanged ones stay withheld', async () => {
    const first = await recall(SESSION);
    const [closed, successor] = episodeIdsOf(first);
    expect(closed).toBeDefined();
    expect(successor).toBeDefined();

    await supersede(harness.driver, {
      oldId: closed ?? '',
      newId: successor ?? '',
      now: RECALLED_AT,
    });

    const second = await recall(SESSION);

    expect(episodeIdsOf(second)).toContain(closed);
    expect(second.episodes?.find((entry) => entry.id === closed)?.currency).toBe('superseded');
    expect(episodeIdsOf(second)).not.toContain(successor);
  });
});

describe('a recall that inspects the past', () => {
  const SESSION = 'dedup-int-time-travel-session';

  it('repeats everything and records nothing, since it asked a question about then', async () => {
    await recall(SESSION);
    const recorded = readServedItems(db, SESSION);
    expect(recorded.size).toBeGreaterThan(0);

    const historical = await handleRecall(
      deps,
      { query: QUERY, knew_at: RECALLED_AT.toISOString() },
      { identity: SESSION, now: RECALLED_AT },
    );

    expect(episodeIdsOf(historical).length).toBeGreaterThan(0);
    expect(historical.metadata.suppressed_repeats).toBeUndefined();
    expect([...readServedItems(db, SESSION).keys()].sort()).toEqual([...recorded.keys()].sort());
  });
});

describe('the kill switch', () => {
  const SESSION = 'dedup-int-knob-off-session';

  it('serves the same pack twice and records nothing when it is off', async () => {
    const off = { config: config({ sessionDedup: false }) };

    const first = await recall(SESSION, off);
    const second = await recall(SESSION, off);

    expect(episodeIdsOf(second)).toEqual(episodeIdsOf(first));
    expect(second.rendered_text).toBe(first.rendered_text);
    expect(second.metadata.token_estimate).toBe(first.metadata.token_estimate);
    expect(second.metadata.suppressed_repeats).toBeUndefined();
    expect(readServedItems(db, SESSION).size).toBe(0);
  });
});

/**
 * The record describes one agent's live context, so it has to die with the session. Both close
 * paths are exercised: the DELETE a well-behaved client sends, and the idle sweep, which is
 * what a client that tears down its own transport leaves behind.
 */
describe('the record does not outlive the session', () => {
  let service: AionMcpService;
  let sweeper: SessionIdleSweeper;
  let url: URL;

  async function open(): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
    const client = new Client({ name: 'aion-session-dedup-test', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(url);
    await client.connect(transport);
    return { client, transport };
  }

  beforeAll(async () => {
    const backend: ToolBackend = {
      recall: (args, identity) => handleRecall(deps, args, { identity }),
      reflection: () => Promise.reject(new Error('not used by this suite')),
    };
    // The composition the service boots with: a close drops the session record, and the sweep
    // purges what belongs to sessions no close will ever name.
    service = new AionMcpService({
      backend,
      logger,
      host: '127.0.0.1',
      port: 0,
      onSessionClosed: (sessionId) => {
        deleteServedItems(db, sessionId);
      },
    });
    const port = await service.listen();
    url = new URL(`http://127.0.0.1:${String(port)}${MCP_PATH}`);
    sweeper = new SessionIdleSweeper(service, {
      idleMs: IDLE_MS,
      purgeIdleBefore: (cutoff) => {
        purgeServedItemsIdleSince(db, cutoff.toISOString());
      },
    });
  });

  afterAll(async () => {
    await service.close();
  });

  it('drops the record when the client sends its DELETE', async () => {
    const { client, transport } = await open();
    await client.callTool({ name: 'recall', arguments: { query: QUERY } });
    const sessionId = transport.sessionId ?? '';
    expect(readServedItems(db, sessionId).size).toBeGreaterThan(0);

    await transport.terminateSession();
    await client.close();

    expect(readServedItems(db, sessionId).size).toBe(0);
  });

  it('drops it on the idle sweep for a client that never says goodbye', async () => {
    const { client, transport } = await open();
    await client.callTool({ name: 'recall', arguments: { query: QUERY } });
    const sessionId = transport.sessionId ?? '';

    // A bare close(): the SDK tears down its own transport and issues no DELETE.
    await client.close();
    expect(readServedItems(db, sessionId).size).toBeGreaterThan(0);

    sweeper.sweepOnce(new Date(Date.now() + IDLE_MS + 50));

    expect(readServedItems(db, sessionId).size).toBe(0);
  });
});
