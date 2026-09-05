import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CueCache } from './cues.js';
import { handleRecall, type RecallDeps } from './recall.js';
import { RecallSideEffects, REINFORCEMENT_TRIGGER } from './side-effects.js';
import { waitFor } from './test-support/wait-for.fixture.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import type { Config } from '../../infrastructure/config/schema.js';
import {
  bootstrapBackbone,
  type BootstrapBackboneResult,
} from '../../infrastructure/graph/backbone.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import { withCurrency } from '../../infrastructure/graph/read-modes.js';
import { fulltextSeeds, vectorSeeds } from '../../infrastructure/graph/seed-queries.js';
import { accessMetadata } from '../../infrastructure/graph/test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger, type Logger } from '../../infrastructure/logging/logger.js';
import type { Provider, Vector } from '../../infrastructure/providers/types.js';
import { openSqliteHandle, type SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { listReinforcementSignals } from '../../infrastructure/sqlite/reinforcement-queue.js';
import { handleReflection } from '../../reflection/application/intake.js';
import { LaneAssigner } from '../../reflection/application/lanes.js';
import { SessionManager } from '../../session/session-manager.js';

/**
 * Covers recall's two side effects end to end: this reuses `recall.int.test.ts`'s fixture
 * shape (one episode reachable directly, one reachable only through the session it shares
 * with the first) because that same co-activated pair is exactly what reinforcement and
 * access-tracking need to prove themselves against.
 */

const EMBED_DIMENSION = 8;
const WRITE_SESSION = 'side-effects-int-write-session';
const READ_SESSION = 'side-effects-int-read-session';

const UNRELATED_AT = new Date('2026-06-01T10:00:00.000Z');
const WEBHOOKS_AT = new Date('2026-06-01T11:00:00.000Z');
const RECALLED_AT = new Date('2026-06-02T09:00:00.000Z');

const WEBHOOKS_OBSERVATION =
  'we picked webhooks for the ingestion service because polling was too slow';
const UNRELATED_OBSERVATION = 'the standup moved to nine thirty on tuesdays';

const QUERY = 'why did we pick webhooks for ingestion';
const CUE = 'webhooks';

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
  if (lowered.includes('standup')) {
    return axis(1);
  }
  return axis(2);
}

const provider: Provider = {
  embed: (texts) => Promise.resolve(texts.map(vectorFor)),
  generate: () => Promise.resolve({ query_cues: [CUE], summary_cues: [], recent_turn_cues: [] }),
};

function config(): Config {
  return {
    ...DEFAULTS,
    models: { ...DEFAULTS.models, embedDimension: EMBED_DIMENSION },
    recall: { ...DEFAULTS.recall, vectorLimit: 1 },
    contextResonance: { ...DEFAULTS.contextResonance, seedLimit: 1 },
  };
}

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let logger: Logger;
let sessions: SessionManager;
let backbone: BootstrapBackboneResult;
let sideEffects: RecallSideEffects;
let deps: RecallDeps;
let webhooksEpisodeId: string;
let unrelatedEpisodeId: string;

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
      acceptHookCapture: true,
    },
    { observations: [observation] },
    { identity: WRITE_SESSION, now },
  );
  return result.episode_id;
}

function sortedPair(a: string, b: string): string {
  return [a, b].sort().join('|');
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-side-effects-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'debug' });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  backbone = await bootstrapBackbone(harness.driver, { memberName: 'Ryan Huber' });
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

  unrelatedEpisodeId = await push(UNRELATED_OBSERVATION, UNRELATED_AT);
  webhooksEpisodeId = await push(WEBHOOKS_OBSERVATION, WEBHOOKS_AT);

  await waitFor('the vector index to cover both episodes', async () => {
    const rows = await vectorSeeds(harness.driver, {
      vector: axis(0),
      limit: 10,
      mode: withCurrency(),
    });
    return rows.length >= 2;
  });

  await waitFor('the fulltext index to cover the webhooks episode', async () => {
    const rows = await fulltextSeeds(harness.driver, {
      query: CUE,
      limit: 10,
      mode: withCurrency(),
    });
    return rows.some((row) => row.id === webhooksEpisodeId);
  });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('recall side effects over a substrate written by the real intake path', () => {
  it('enqueues reinforcement pairs inline and batches access tracking off the response path', async () => {
    expect(listReinforcementSignals(db)).toHaveLength(0);

    const pack = await handleRecall(
      deps,
      { query: QUERY },
      {
        identity: READ_SESSION,
        now: RECALLED_AT,
      },
    );

    // Reinforcement is written inline from the listener, before handleRecall's caller
    // resumes.
    const signals = listReinforcementSignals(db);
    expect(signals.length).toBeGreaterThan(0);

    // Every id the spread could have co-activated. The reading session's node is not among
    // them any more, since recall produces no content and mints nothing, but the write
    // session's is, since both episodes participate in it.
    const knownIds = new Set([
      webhooksEpisodeId,
      unrelatedEpisodeId,
      WRITE_SESSION,
      READ_SESSION,
      backbone.member.id,
      backbone.workspace.id,
    ]);
    for (const signal of signals) {
      expect(signal.trigger).toBe(REINFORCEMENT_TRIGGER);
      expect(knownIds.has(signal.sourceId)).toBe(true);
      expect(knownIds.has(signal.targetId)).toBe(true);
    }
    const enqueuedPairs = new Set(signals.map((s) => sortedPair(s.sourceId, s.targetId)));
    expect(enqueuedPairs.has(sortedPair(webhooksEpisodeId, unrelatedEpisodeId))).toBe(true);

    // The access-tracking write is deferred, which means the response never waits on it,
    // not that the write is provably absent at any instant after the response. Asserting
    // absence here is a race the batcher can legitimately win on fast infrastructure, so
    // the contract check is whenIdle() resolving separately from the already-held pack.
    await sideEffects.whenIdle();

    // One episode surfaces, not two: the spread reached the other and nothing measured it,
    // so it is co-activated for reinforcement and refused for the pack. Access tracking
    // follows what was served, which is the narrower of the two sets.
    const surfacedIds = (pack.episodes ?? []).map((item) => item.id).sort();
    expect(surfacedIds).toEqual([webhooksEpisodeId]);

    for (const id of surfacedIds) {
      const after = await accessMetadata(harness.driver, id);
      expect(after.lastAccessed).toBeInstanceOf(Date);
      expect(after.accessCount).toBe(1);
    }
  });
});
