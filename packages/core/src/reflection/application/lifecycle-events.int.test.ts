import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ReflectionIntakeDeps } from './intake.js';
import { LaneAssigner } from './lanes.js';
import { recordLifecycleEvent } from './lifecycle-events.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import type { Config } from '../../infrastructure/config/schema.js';
import { bootstrapBackbone } from '../../infrastructure/graph/backbone.js';
import { MEMORY_PROPERTIES } from '../../infrastructure/graph/episodes.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import { withCurrency } from '../../infrastructure/graph/read-modes.js';
import { fulltextSeeds } from '../../infrastructure/graph/seed-queries.js';
import { SYSTEM_SESSION_IDENTITY } from '../../infrastructure/graph/sessions.js';
import {
  countOutgoingEdges,
  edgeTargetId,
  episodeIdsInSession,
  nodeProperties,
} from '../../infrastructure/graph/test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger, type Logger } from '../../infrastructure/logging/logger.js';
import type { Provider, Vector } from '../../infrastructure/providers/types.js';
import { openSqliteHandle, type SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { CueCache } from '../../recall/application/cues.js';
import { handleRecall, type RecallDeps } from '../../recall/application/recall.js';
import { waitFor } from '../../recall/application/test-support/wait-for.fixture.js';
import { SessionManager } from '../../session/session-manager.js';

const EMBED_DIMENSION = 8;
const READ_SESSION = 'lifecycle-int-read-session';

const BIRTH_AT = new Date('2026-09-05T09:00:00.000Z');
const REPLAY_AT = new Date('2026-09-05T10:00:00.000Z');
const RECALLED_AT = new Date('2026-09-05T11:00:00.000Z');

const BIRTH_TEXT =
  'substrate initialized: 7 migrations applied, backbone created for Test User, profile full';
const REPLAY_TEXT =
  'replay completed: 12 of 14 experiences replayed, 2 skipped, 0 failed, pipeline v1';

const QUERY = 'when was this substrate initialized';
const CUE = 'substrate initialized';

/**
 * One axis for every text, so recall's ranking is not what this file measures: what it measures
 * is that an event stored through the lifecycle path is reachable by the ordinary read path.
 */
const provider: Provider = {
  embed: (texts) =>
    Promise.resolve(
      texts.map((): Vector => Array.from({ length: EMBED_DIMENSION }, (_, slot) => 1 / (slot + 1))),
    ),
  generate: () => Promise.resolve({ query_cues: [CUE], summary_cues: [], recent_turn_cues: [] }),
};

function config(): Config {
  return {
    ...DEFAULTS,
    models: { ...DEFAULTS.models, embedDimension: EMBED_DIMENSION },
    recall: { ...DEFAULTS.recall, sessionDedup: false, ownSessionFilter: false },
  };
}

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let logger: Logger;
let substrateId: string;
let memberId: string;
let workspaceId: string;
let birthEpisodeId: string;

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-lifecycle-events-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  const backbone = await bootstrapBackbone(harness.driver, { memberName: 'Test User' });
  substrateId = backbone.substrate.id;
  memberId = backbone.member.id;
  workspaceId = backbone.workspace.id;

  const deps: ReflectionIntakeDeps = {
    driver: harness.driver,
    db,
    sessions: new SessionManager(harness.driver, { memberId, workspaceId }),
    provider,
    logger,
    entropyThreshold: DEFAULTS.redaction.entropyThreshold,
    lanes: new LaneAssigner(DEFAULTS.lanes),
    workerMaxAttempts: DEFAULTS.operational.workerMaxAttempts,
    acceptHookCapture: true,
  };

  await recordLifecycleEvent(deps, {
    event: 'substrate_initialized',
    text: BIRTH_TEXT,
    now: BIRTH_AT,
  });
  await recordLifecycleEvent(deps, {
    event: 'replay_completed',
    text: REPLAY_TEXT,
    now: REPLAY_AT,
  });

  const episodes = await episodeIdsInSession(harness.driver, SYSTEM_SESSION_IDENTITY);
  const properties = await Promise.all(
    episodes.map(async (id) => ({ id, props: await nodeProperties(harness.driver, id) })),
  );
  birthEpisodeId = properties.find((entry) =>
    String(entry.props[MEMORY_PROPERTIES.text]).includes('substrate initialized'),
  )!.id;

  await waitFor('the fulltext index to cover the birth event', async () => {
    const rows = await fulltextSeeds(harness.driver, {
      query: CUE,
      limit: 10,
      mode: withCurrency(),
    });
    return rows.some((row) => row.id === birthEpisodeId);
  });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('lifecycle events against a live graph', () => {
  it('stores the birth event with the system origin it was recorded under', async () => {
    const props = await nodeProperties(harness.driver, birthEpisodeId);

    expect(props[MEMORY_PROPERTIES.text]).toContain(BIRTH_TEXT);
    expect(props[MEMORY_PROPERTIES.sessionId]).toBe(SYSTEM_SESSION_IDENTITY);
    expect(props[MEMORY_PROPERTIES.originChannel]).toBe('system');
    expect(props[MEMORY_PROPERTIES.originEvent]).toBe('substrate_initialized');
  });

  it('chains every lifecycle event in the one system session', async () => {
    const episodes = await episodeIdsInSession(harness.driver, SYSTEM_SESSION_IDENTITY);

    expect(episodes).toHaveLength(2);
  });

  it('hangs the system session off the substrate rather than the member', async () => {
    const initiator = await edgeTargetId(harness.driver, 'INITIATED_BY', SYSTEM_SESSION_IDENTITY);

    expect(initiator).toBe(substrateId);
    expect(initiator).not.toBe(memberId);
    // The substrate's session is its own chain of one, so it never joins the member's.
    expect(await countOutgoingEdges(harness.driver, 'FOLLOWS', SYSTEM_SESSION_IDENTITY)).toBe(0);
  });

  it('serves the birth event back to a recall that asks about it', async () => {
    const deps: RecallDeps = {
      driver: harness.driver,
      db,
      sessions: new SessionManager(harness.driver, { memberId, workspaceId }),
      provider,
      config: config(),
      cueCache: new CueCache(),
      logger,
    };

    const pack = await handleRecall(
      deps,
      { query: QUERY },
      { identity: READ_SESSION, now: RECALLED_AT },
    );

    const hit = pack.episodes?.find((item) => item.id === birthEpisodeId);
    expect(hit?.content).toContain(BIRTH_TEXT);
  });
});
