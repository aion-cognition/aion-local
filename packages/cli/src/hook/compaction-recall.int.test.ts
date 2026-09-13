import {
  bootstrapBackbone,
  CueCache,
  DEFAULTS,
  fulltextSeeds,
  handleReflection,
  handleRecall,
  LaneAssigner,
  openLogger,
  openSqliteHandle,
  readServedItems,
  runGraphMigrations,
  SessionManager,
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
import {
  directIntakePublisher,
  drainAcceptedVectors,
} from '@aion/core/reflection/test-support/direct-intake.fixture.js';
import { AionMcpService, MCP_PATH, type ToolBackend } from '@aion/mcp';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { sessionStart } from './events.js';
import { HOOK_TIMEOUT_MS, type HookOptions } from './options.js';
import { readHookState, writeHookState, type HookState } from './state.js';

/**
 * The connected diagnostic for the compaction/suppression question: does the served-items
 * ledger survive a compaction, and does the reset marker actually stop it from withholding a
 * memory that may not have survived the compaction's own summary? Driven through the real
 * `sessionStart` hook function over a live MCP transport, so the harness session id (stamped
 * into every recall call, stable across a compaction) and the MCP transport's own session id
 * (a fresh one every hook fire, since each fire opens and closes its own connection) stay
 * genuinely distinct, the way they are in production.
 */

const EMBED_DIMENSION = 8;
const MEMBER_NAME = 'Ryan Huber';
const WRITE_SESSION = 'compaction-int-write-session';
const HARNESS_SESSION_ID = 'compaction-int-harness-session';
const BYSTANDER_SESSION_ID = 'compaction-int-bystander-session';
const READY_MS = 30_000;

const STORED_AT = new Date('2026-06-01T10:00:00.000Z');
const NOW = new Date('2026-06-02T09:00:00.000Z');

const CUE = 'webhooks';
const OBSERVATION = 'we picked webhooks for the ingestion service because polling was too slow';
const MEMORY_PHRASE = 'webhooks for the ingestion service';

const SEEDED_CURSOR: HookState = {
  offset: 42,
  lastFlushAt: '2026-06-02T08:59:00.000Z',
  fingerprint: 'pre-compact-fingerprint',
  tools: [],
};

/** Polls until the graph's async indexes catch up to a write this suite just made. */
async function waitFor(
  label: string,
  deadlineMs: number,
  ready: () => Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (await ready()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });
  }
  throw new Error(`timed out waiting for ${label}`);
}

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

function config(): Config {
  return { ...DEFAULTS, models: { ...DEFAULTS.models, embedDimension: EMBED_DIMENSION } };
}

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let stateDir: string;
let logger: Logger;
let service: AionMcpService;
let endpoint: string;

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-compaction-recall-int-'));
  stateDir = join(dataDir, 'hook-state');
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'debug' });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  const backbone = await bootstrapBackbone(harness.driver, { memberName: MEMBER_NAME });
  const sessions = new SessionManager(harness.driver, {
    memberId: backbone.member.id,
    workspaceId: backbone.workspace.id,
  });
  const deps: RecallDeps = {
    driver: harness.driver,
    db,
    sessions,
    provider,
    config: config(),
    cueCache: new CueCache(),
    logger,
  };

  await handleReflection(
    {
      driver: harness.driver,
      db,
      sessions,
      logger,
      entropyThreshold: DEFAULTS.redaction.entropyThreshold,
      lanes: new LaneAssigner(DEFAULTS.lanes),
      workerMaxAttempts: DEFAULTS.operational.workerMaxAttempts,
      publications: directIntakePublisher(harness.driver, db),
    },
    { observations: [OBSERVATION] },
    { identity: WRITE_SESSION, now: STORED_AT },
  );
  // Intake queues the embedding rather than performing it, so the fixture runs the row the
  // worker would run: what this file asserts on is vector search, which needs the vectors.
  await drainAcceptedVectors(harness.driver, provider);

  await waitFor('the vector index to cover the stored episode', READY_MS, async () => {
    const rows = await vectorSeeds(harness.driver, {
      vector: axis(0),
      limit: 20,
      mode: withCurrency(),
    });
    return rows.length >= 1;
  });
  await waitFor('the fulltext index to cover the stored episode', READY_MS, async () => {
    const rows = await fulltextSeeds(harness.driver, {
      query: CUE,
      limit: 20,
      mode: withCurrency(),
    });
    return rows.length >= 1;
  });

  const backend: ToolBackend = {
    recall: (args, identity) => handleRecall(deps, args, { identity }),
    reflection: () => Promise.reject(new Error('not used by this suite')),
    // The archive tools are not this file's subject; they refuse rather than answer, so a
    // case that reached them would fail rather than pass on a fixture.
    sourceSearch: () => Promise.reject(new Error('not used by this suite')),
    source: () => Promise.reject(new Error('not used by this suite')),
  };
  service = new AionMcpService({ backend, logger, host: '127.0.0.1', port: 0 });
  const port = await service.listen();
  endpoint = `http://127.0.0.1:${String(port)}${MCP_PATH}`;
}, 300_000);

afterAll(async () => {
  await service.close();
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

type SessionStartRun = { readonly exit: number; readonly stdout: readonly string[] };

/**
 * Fires the real hook function, one fresh MCP transport connection per call (`sessionStart`
 * opens and closes its own `McpHookClient`), against the live service started above. The
 * harness `session_id` in `input` is what recall keys suppression on; the transport session
 * id this connection is issued is unrelated and never surfaces here, the way a real hook fire
 * never sees it either.
 */
function fireSessionStart(input: Record<string, unknown>): Promise<SessionStartRun> {
  const stdout: string[] = [];
  const options: HookOptions = {
    event: 'session-start',
    harness: 'claude',
    stopMode: 'push',
    minChars: 40,
    route: 'keyed',
    stateDir,
    endpoint,
    fetchImpl: fetch,
    timeoutMs: HOOK_TIMEOUT_MS,
    now: () => NOW,
    stdout: (line) => stdout.push(line),
    stderr: () => undefined,
  };
  return sessionStart({ input, options }).then((exit) => ({ exit, stdout }));
}

function emittedText(run: SessionStartRun): string | undefined {
  const [line] = run.stdout;
  if (line === undefined) {
    return undefined;
  }
  const frame = JSON.parse(line) as { hookSpecificOutput?: { additionalContext?: string } };
  return frame.hookSpecificOutput?.additionalContext;
}

describe('a compact-source SessionStart against a live substrate', () => {
  it('re-serves after a compaction, resumes suppressing, and leaves a bystander session and the capture cursor untouched', async () => {
    // A PreCompact flush would have just advanced this session's transcript cursor; the
    // reset that follows must not move it, since it belongs to a different subsystem.
    writeHookState(stateDir, HARNESS_SESSION_ID, SEEDED_CURSOR);

    // A session with no relation to the one about to be reset: it gets served the same
    // memory and must keep suppressing its own repeat throughout, whatever happens elsewhere.
    const bystanderFirst = await fireSessionStart({
      session_id: BYSTANDER_SESSION_ID,
      source: 'startup',
    });
    expect(emittedText(bystanderFirst)).toContain(MEMORY_PHRASE);
    const bystanderServedAfterFirst = [...readServedItems(db, BYSTANDER_SESSION_ID).keys()].sort();
    expect(bystanderServedAfterFirst.length).toBeGreaterThan(0);

    // An ordinary SessionStart serves the fixture and records it against the harness session.
    const first = await fireSessionStart({ session_id: HARNESS_SESSION_ID, source: 'startup' });
    expect(emittedText(first)).toContain(MEMORY_PHRASE);
    expect(readServedItems(db, HARNESS_SESSION_ID).size).toBeGreaterThan(0);

    // The question this diagnoses: a compaction may or may not have carried this memory
    // forward, and nothing tells the ledger either way. A miss here is the pack coming back
    // with no memory at all, not a wire field going unset.
    const compacted = await fireSessionStart({ session_id: HARNESS_SESSION_ID, source: 'compact' });
    expect(emittedText(compacted)).toContain(MEMORY_PHRASE);

    // The reset is one call's worth, not a standing mode: the pack it just served is recorded
    // like any other, so the very next ordinary call suppresses it again.
    const resumed = await fireSessionStart({ session_id: HARNESS_SESSION_ID, source: 'startup' });
    expect(emittedText(resumed)).toBeUndefined();

    // The bystander session's ledger never moved: same rows, and its own repeat still
    // suppresses, since the reset named one session only.
    const bystanderSecond = await fireSessionStart({
      session_id: BYSTANDER_SESSION_ID,
      source: 'startup',
    });
    expect(emittedText(bystanderSecond)).toBeUndefined();
    expect([...readServedItems(db, BYSTANDER_SESSION_ID).keys()].sort()).toEqual(
      bystanderServedAfterFirst,
    );

    // And the harness session's own transcript cursor sits exactly where the pre-compaction
    // flush left it: the reset touched the served-items ledger, nothing in `hook-state`.
    expect(readHookState(stateDir, HARNESS_SESSION_ID)).toEqual(SEEDED_CURSOR);
  });
});
