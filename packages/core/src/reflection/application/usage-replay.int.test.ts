import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { handleReflection } from './intake.js';
import { LaneAssigner } from './lanes.js';
import { replayUsageEvents } from './usage-replay.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import type { Config } from '../../infrastructure/config/schema.js';
import {
  bootstrapBackbone,
  type BootstrapBackboneResult,
} from '../../infrastructure/graph/backbone.js';
import { upsertEdge } from '../../infrastructure/graph/edges.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import { withCurrency } from '../../infrastructure/graph/read-modes.js';
import { fulltextSeeds, vectorSeeds } from '../../infrastructure/graph/seed-queries.js';
import {
  accessMetadata,
  clearAccessMetadata,
  edgeStrength,
  resetEdgePlasticity,
  type AccessMetadata,
} from '../../infrastructure/graph/test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger, type Logger } from '../../infrastructure/logging/logger.js';
import type { Provider, Vector } from '../../infrastructure/providers/types.js';
import { openSqliteHandle, type SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { listUsageEventsAfter } from '../../infrastructure/sqlite/usage-events.js';
import { sweepEdgeDecay } from '../../plasticity/application/decay.js';
import { flushReinforcementQueue } from '../../plasticity/application/flush.js';
import { boundedReinforcement } from '../../plasticity/domain/reinforcement.js';
import { CueCache } from '../../recall/application/cues.js';
import { handleRecall, type RecallDeps } from '../../recall/application/recall.js';
import { RecallSideEffects } from '../../recall/application/side-effects.js';
import { waitFor } from '../../recall/application/test-support/wait-for.fixture.js';
import { SessionManager } from '../../session/session-manager.js';

/**
 * The claim this file exists for: salience survives a rebuild. A graph rebuilt from the
 * experience archive carries every fact and no access stamps, no learned weights, and no
 * record of a sweep. Replaying the usage stream over it puts those numbers back, exactly.
 *
 * The rebuild is modeled by stripping the properties a rebuild would not have written rather
 * than by standing up a second database: what a replay has to restore is a set of properties,
 * and a graph missing exactly those is the graph a fresh pipeline pass leaves behind.
 *
 * The corpus comes through the real intake path, and the recall through `handleRecall`, so the
 * events under test are the ones the shipped emitters write. The `SIMILAR` edge is seeded
 * directly: enrichment runs in the worker, which no test here starts, and the flush needs an
 * unprotected edge between two co-activated nodes to have anything to move.
 */

const EMBED_DIMENSION = 8;
const WRITE_SESSION = 'usage-replay-int-write-session';
const READ_SESSION = 'usage-replay-int-read-session';

const UNRELATED_AT = new Date('2026-06-01T10:00:00.000Z');
const WEBHOOKS_AT = new Date('2026-06-01T11:00:00.000Z');
const RECALLED_AT = new Date('2026-06-02T09:00:00.000Z');
const FLUSHED_AT = new Date('2026-06-02T10:00:00.000Z');
// Thirty days past the flush, which is where the decay curve peaks, so the sweep moves the
// edge by a full step instead of a number too small to tell from no sweep at all.
const SWEPT_AT = new Date('2026-07-02T10:00:00.000Z');

const SEEDED_STRENGTH = 0.5;
const LEARNING_RATE = 0.1;
const WEIGHT_FLOOR = 0.1;
const DECAY_RATE = 0.02;
const PEAK_DAYS = 30;
const SIGMA = 15;
const SWEEP_BATCH = 50;

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
/** Every node the spread can reach, so the comparison covers the ones a replay must leave alone. */
let salienceNodeIds: readonly string[];

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

function accessSnapshot(): Promise<AccessMetadata[]> {
  return Promise.all(salienceNodeIds.map((id) => accessMetadata(harness.driver, id)));
}

function similarStrength(): Promise<number | undefined> {
  return edgeStrength(harness.driver, 'SIMILAR', webhooksEpisodeId, unrelatedEpisodeId);
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-usage-replay-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'error' });
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
  salienceNodeIds = [
    webhooksEpisodeId,
    unrelatedEpisodeId,
    WRITE_SESSION,
    READ_SESSION,
    backbone.member.id,
    backbone.workspace.id,
  ];

  await upsertEdge(harness.driver, {
    type: 'SIMILAR',
    sourceId: webhooksEpisodeId,
    targetId: unrelatedEpisodeId,
    strength: SEEDED_STRENGTH,
    confidence: 1,
    signals: ['episodic'],
    provenance: ['test'],
    count: 1,
    now: WEBHOOKS_AT,
  });

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

describe('the usage stream replayed over a graph that kept its facts and lost its salience', () => {
  it('restores the access stamps and the edge weight the live run produced', async () => {
    await handleRecall(deps, { query: QUERY }, { identity: READ_SESSION, now: RECALLED_AT });
    await sideEffects.whenIdle();

    await flushReinforcementQueue(
      { driver: harness.driver, db, logger },
      {
        batchSize: 100,
        learningRate: LEARNING_RATE,
        weightFloor: WEIGHT_FLOOR,
        now: FLUSHED_AT,
      },
    );
    await sweepEdgeDecay(
      { driver: harness.driver, db, logger },
      {
        batchSize: SWEEP_BATCH,
        decayRate: DECAY_RATE,
        peakDays: PEAK_DAYS,
        sigma: SIGMA,
        weightFloor: WEIGHT_FLOOR,
        now: SWEPT_AT,
      },
    );

    // All three emitters wrote, in the order the substrate lived them.
    expect(listUsageEventsAfter(db, undefined, 100).map((event) => event.kind)).toEqual([
      'recall_access',
      'reinforcement_applied',
      'decay_sweep',
    ]);

    const stamps = await accessSnapshot();
    const weight = await similarStrength();
    // The run has to have moved something, or the comparison below proves nothing. The weight
    // is one bounded step up from the seed and one full-strength decay step back down, which is
    // both operations having reached the same edge.
    expect(stamps.some((entry) => entry.accessCount === 1)).toBe(true);
    expect(weight).toBeCloseTo(
      boundedReinforcement(SEEDED_STRENGTH, LEARNING_RATE, WEIGHT_FLOOR) - DECAY_RATE,
      10,
    );

    // The rebuild: every fact still stands, and nothing use wrote survives it.
    await clearAccessMetadata(harness.driver, salienceNodeIds);
    await resetEdgePlasticity(
      harness.driver,
      'SIMILAR',
      webhooksEpisodeId,
      unrelatedEpisodeId,
      SEEDED_STRENGTH,
    );
    expect(await accessSnapshot()).toEqual(salienceNodeIds.map(() => ({})));
    expect(await similarStrength()).toBe(SEEDED_STRENGTH);

    const report = await replayUsageEvents(
      { driver: harness.driver, db, logger },
      { batchSize: 2 },
    );

    expect(report).toMatchObject({
      scanned: 3,
      accessApplied: 1,
      reinforcementApplied: 1,
      decayApplied: 1,
      skipped: 0,
      failed: 0,
    });
    expect(await accessSnapshot()).toEqual(stamps);
    expect(await similarStrength()).toBe(weight);
  });
});
