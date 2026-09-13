import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runCheckedRecall, type CheckedRecallDeps } from './checked-recall.js';
import { CueCache } from './cues.js';
import { waitFor } from './test-support/wait-for.fixture.js';
import { ownershipCensusEstablished } from '../../evidence/application/ownership.js';
import { EvidenceResolver } from '../../evidence/application/resolver.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import type { Config } from '../../infrastructure/config/schema.js';
import { bootstrapBackbone } from '../../infrastructure/graph/backbone.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import { withCurrency } from '../../infrastructure/graph/read-modes.js';
import { vectorSeeds } from '../../infrastructure/graph/seed-queries.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger, type Logger } from '../../infrastructure/logging/logger.js';
import type { Provider, Vector } from '../../infrastructure/providers/types.js';
import { PublicationCoordinator } from '../../infrastructure/publication/coordinator.js';
import { openSqliteHandle, type SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { publishReadinessPolicy } from '../../infrastructure/sqlite/readiness-policies.js';
import { readSourcePartTurnIds } from '../../infrastructure/sqlite/source-identity.js';
import { INSTALLED_PUBLICATION_HANDLERS } from '../../reflection/application/installed-publications.js';
import { handleReflection } from '../../reflection/application/intake.js';
import { LaneAssigner } from '../../reflection/application/lanes.js';
import { PIPELINE_VERSION } from '../../reflection/domain/version.js';
import { SessionManager } from '../../session/session-manager.js';

/**
 * The own-session subtraction over the certified reading, which is the one a served request
 * actually takes.
 *
 * The pack's own late graph reads answer from the `session_id` a raw node carries and need no
 * census. The resolver does not: it derives ownership from the incidence records and refuses to
 * call the answer whole until the three ownership scopes on the node are counted. That is why
 * this file drives `runCheckedRecall` against a real coordinator rather than the bare pipeline.
 */

const EMBED_DIMENSION = 8;
const WRITE_SESSION = 'origin-census-writer';
const READ_SESSION = 'origin-census-reader';

const UNRELATED_AT = new Date('2026-06-01T10:00:00.000Z');
const STORED_AT = new Date('2026-06-01T11:00:00.000Z');
const RECALLED_AT = new Date('2026-06-02T09:00:00.000Z');

const QUERY = 'why did ingestion move onto webhooks';
const CUE = 'webhooks';

/** Turns as well as an observation, so the episode the session captured carries parts. */
const CAPTURE = {
  turns: [
    {
      role: 'user',
      text: 'why are we moving the ingestion service onto webhooks',
      occurred_at: '2026-06-01T11:00:00.000Z',
    },
    {
      role: 'assistant',
      text: 'because polling on webhooks added ninety seconds of lag to every delivery',
      occurred_at: '2026-06-01T11:00:05.000Z',
    },
  ],
  observations: [
    'we moved the ingestion service onto webhooks because polling added ninety seconds of lag',
  ],
};
const UNRELATED = { observations: ['the standup moved to nine thirty on tuesdays'] };

function axis(index: number): Vector {
  const vector = new Array<number>(EMBED_DIMENSION).fill(0);
  vector[index] = 1;
  return vector;
}

function vectorFor(text: string): Vector {
  const lowered = text.toLowerCase();
  if (lowered.includes('webhook')) {
    return axis(0);
  }
  return lowered.includes('standup') ? axis(1) : axis(2);
}

const provider: Provider = {
  embed: (texts) => Promise.resolve(texts.map(vectorFor)),
  generate: () => Promise.resolve({ query_cues: [CUE], summary_cues: [], recent_turn_cues: [] }),
};

function config(): Config {
  return {
    ...DEFAULTS,
    models: { ...DEFAULTS.models, embedDimension: EMBED_DIMENSION },
    // The origin subtraction is the subject, so the delivery record stays out of the way: both
    // sessions ask the same question more than once here.
    recall: { ...DEFAULTS.recall, sessionDedup: false },
  };
}

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let logger: Logger;
let sessions: SessionManager;
let coordinator: PublicationCoordinator;
let episodeId: string;
let turnIds: readonly string[];

function deps(): CheckedRecallDeps {
  return {
    driver: harness.driver,
    db,
    sessions,
    provider,
    config: config(),
    cueCache: new CueCache(),
    logger,
    resolver: new EvidenceResolver({ driver: harness.driver, db, logger }),
    coordinator,
  };
}

async function read(identity: string, stamped?: string, reset = false) {
  const outcome = await runCheckedRecall(
    deps(),
    {
      query: QUERY,
      ...(stamped === undefined ? {} : { session_id: stamped }),
      ...(reset ? { reset_delivery_suppression: true } : {}),
    },
    { identity, now: RECALLED_AT },
  );
  if (outcome.status !== 'pack') {
    throw new Error(`recall refused: ${outcome.refusal.reason}`);
  }
  return outcome.pack;
}

function servedIds(pack: Awaited<ReturnType<typeof read>>): readonly string[] {
  return [
    ...(pack.facts ?? []),
    ...(pack.episodes ?? []),
    ...(pack.narratives ?? []),
    ...(pack.preferences ?? []),
    ...(pack.resonant ?? []),
  ].map((entry) => entry.id);
}

async function push(payload: unknown, identity: string, now: Date): Promise<string> {
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
      publications: coordinator,
      acceptHookCapture: true,
    },
    payload,
    { identity, now },
  );
  return result.episode_id;
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-origin-census-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  publishReadinessPolicy(
    db,
    { pipelineVersion: PIPELINE_VERSION, stageNames: ['entities'], transferCapabilities: [] },
    new Date('2026-01-01T00:00:00.000Z'),
  );

  const backbone = await bootstrapBackbone(harness.driver, { memberName: 'Ryan Huber' });
  sessions = new SessionManager(harness.driver, {
    memberId: backbone.member.id,
    workspaceId: backbone.workspace.id,
  });
  coordinator = new PublicationCoordinator({
    driver: harness.driver,
    db,
    logger,
    handlers: [...INSTALLED_PUBLICATION_HANDLERS],
    now: () => STORED_AT,
  });
  await coordinator.initialize();

  await push(UNRELATED, READ_SESSION, UNRELATED_AT);
  episodeId = await push(CAPTURE, WRITE_SESSION, STORED_AT);
  turnIds = readSourcePartTurnIds(db, episodeId);

  await waitFor('the vector index to cover the stored episode', async () => {
    const rows = await vectorSeeds(harness.driver, {
      vector: axis(0),
      limit: 10,
      mode: withCurrency(),
    });
    return rows.some((row) => row.id === episodeId);
  });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('a certified recall asking about what the session just captured', () => {
  it('counted the ownership scopes on the episode the acceptance minted', () => {
    expect(ownershipCensusEstablished(db, episodeId)).toBe(true);
  });

  it('withholds that episode from the session that wrote it and serves it to another', async () => {
    const mine = await read(WRITE_SESSION);
    const theirs = await read(READ_SESSION);

    expect(servedIds(theirs)).toContain(episodeId);
    expect(servedIds(mine)).not.toContain(episodeId);
    expect(mine.metadata.suppressed_own).toBeGreaterThan(0);
    expect(theirs.metadata.suppressed_own).toBeUndefined();
  });

  it("says so in the rendered block, not only in the pack's metadata", async () => {
    const mine = await read(WRITE_SESSION);

    expect(mine.rendered_text).toContain("from this session's own turns");
  });

  /**
   * Both ends of the request key on the same expression: the stamped `session_id` when the caller
   * sends one, and the transport identity only as the fallback. A hook fire sends one on every
   * call, so the withholding follows the conversation rather than the connection it opened.
   */
  it('keys the subtraction on the stamped session rather than on the transport', async () => {
    const stamped = await read('a-transport-that-wrote-nothing', WRITE_SESSION);
    const bare = await read('a-transport-that-wrote-nothing');

    expect(servedIds(stamped)).not.toContain(episodeId);
    expect(servedIds(bare)).toContain(episodeId);
  });

  /**
   * What a compaction re-prime asks for. This subtraction rests on the conversation still holding
   * what it captured, and a summarized transcript is the caller saying that stopped being true.
   * The same flag that makes recall forget what it served makes it stop calling these the
   * session's own, for the one call that sends it.
   */
  it('hands the writing session its own capture back on a compaction re-prime', async () => {
    const reprimed = await read(WRITE_SESSION, undefined, true);

    expect(servedIds(reprimed)).toContain(episodeId);
    expect(reprimed.metadata.suppressed_own).toBeUndefined();
  });

  /**
   * Both halves of the statement. The ownership line goes because this endpoint's three counters
   * are counted now; the interpretation line stays because nothing establishes a census for the
   * graph's own node scope, on any item, before or after.
   */
  it('drops the ownership gap for that episode and keeps the interpretation one', async () => {
    const theirs = await read(READ_SESSION);
    const gaps = theirs.metadata.history_coverage?.gaps ?? [];
    const mine = gaps.filter((entry) => entry.id === episodeId);

    expect(mine).toContainEqual({
      id: episodeId,
      field: 'interpretation_text',
      reason: 'unverified_scope',
    });
    expect(mine).not.toContainEqual({
      id: episodeId,
      field: 'ownership',
      reason: 'unverified_scope',
    });
  });
});

/**
 * The pack a second session gets is the whole point of withholding from the first: what the
 * writing session is spared is an echo, and what the reader gets is a memory.
 */
describe('the turns beside that episode', () => {
  it('counted every one of them at the acceptance that drew their ids', () => {
    expect(turnIds.length).toBeGreaterThan(0);
    for (const turnId of turnIds) {
      expect(ownershipCensusEstablished(db, turnId)).toBe(true);
    }
  });
});
