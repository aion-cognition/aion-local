import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll } from 'vitest';

import { waitFor } from './wait-for.fixture.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import type { Config } from '../../../infrastructure/config/schema.js';
import { bootstrapBackbone } from '../../../infrastructure/graph/backbone.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import { withCurrency } from '../../../infrastructure/graph/read-modes.js';
import { fulltextSeeds, vectorSeeds } from '../../../infrastructure/graph/seed-queries.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger, type Logger } from '../../../infrastructure/logging/logger.js';
import type { Provider, Vector } from '../../../infrastructure/providers/types.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import { publishReadinessPolicy } from '../../../infrastructure/sqlite/readiness-policies.js';
import { handleReflection } from '../../../reflection/application/intake.js';
import { LaneAssigner } from '../../../reflection/application/lanes.js';
import { PIPELINE_VERSION } from '../../../reflection/domain/version.js';
import {
  directIntakePublisher,
  drainAcceptedVectors,
} from '../../../reflection/test-support/direct-intake.fixture.js';
import { SessionManager } from '../../../session/session-manager.js';
import { CueCache } from '../cues.js';
import type { RecallDeps } from '../recall.js';

/**
 * The substrate the recall integration files read, written once through the real intake path.
 *
 * Split out of `recall.int.test.ts` when that file crossed the standing line cap: the fixture was
 * two thirds of it, and the intention-trigger cases that ride on the same substrate are a
 * different question from what the retrieval legs serve. Each importing file starts its own
 * throwaway harness, so nothing here is shared between them but the shape.
 */

// The seeded graph has no entity named after the substrate, so the skip branch never fires here.
function requireSubstrate(backbone: Awaited<ReturnType<typeof bootstrapBackbone>>) {
  if (backbone.substrate === undefined) {
    throw new Error('backbone skipped the substrate node on a clean graph');
  }
  return backbone.substrate;
}

const EMBED_DIMENSION = 8;
/** The stage list this file's sources are accepted under. No pass runs them here. */
export const REQUIRED_STAGES = ['entities', 'associations'];
const WRITE_SESSION = 'recall-int-write-session';
export const READ_SESSION = 'recall-int-read-session';

const UNRELATED_AT = new Date('2026-06-01T10:00:00.000Z');
const WEBHOOKS_AT = new Date('2026-06-01T11:00:00.000Z');
export const RECALLED_AT = new Date('2026-06-02T09:00:00.000Z');
/** Before either episode was recorded, so a knowledge-time read sees the substrate empty. */
export const BEFORE_ANYTHING = '2026-05-01T00:00:00.000Z';

export const WEBHOOKS_OBSERVATION =
  'we picked webhooks for the ingestion service because polling was too slow';
const UNRELATED_OBSERVATION = 'the standup moved to nine thirty on tuesdays';

export const QUERY = 'why did we pick webhooks for ingestion';
export const CUE = 'webhooks';

export function axis(index: number): Vector {
  const vector = new Array<number>(EMBED_DIMENSION).fill(0);
  vector[index] = 1;
  return vector;
}

/**
 * Deterministic stand-in for the embedding model: the topic decides the axis, so "reachable
 * only by traversal" is a property of the fixture graph rather than of whatever a live
 * model happened to score. Cue extraction is stubbed for the same reason: unit and
 * integration tests here prove the pipeline, never the model's judgment.
 */
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

export const provider: Provider = {
  embed: (texts) => Promise.resolve(texts.map(vectorFor)),
  generate: () => Promise.resolve({ query_cues: [CUE], summary_cues: [], recent_turn_cues: [] }),
};

/**
 * One seed and one vector hit per cue. The narrow budget is the point: a wide one would let
 * every fixture node in as a direct hit and there would be nothing left for traversal to be
 * the only path to.
 *
 * Both session subtractions are off throughout. Every test here asks the same question of the
 * same reading session, and what each one measures is what the substrate answers rather than
 * what that session has already been handed or wrote itself.
 *
 * The `cues` mode, because the stub above answers as the cue model: what these files pin is the
 * retrieval legs under known cues. `assessment.int.test.ts` runs the default mode over the same
 * substrate.
 */
export function config(): Config {
  return {
    ...DEFAULTS,
    models: { ...DEFAULTS.models, embedDimension: EMBED_DIMENSION },
    recall: {
      ...DEFAULTS.recall,
      mode: 'cues',
      vectorLimit: 1,
      sessionDedup: false,
      ownSessionFilter: false,
    },
    contextResonance: { ...DEFAULTS.contextResonance, seedLimit: 1 },
  };
}

export let harness: Neo4jHarness;
export let db: SqliteHandle;
let dataDir: string;
let logger: Logger;
let sessions: SessionManager;
export let deps: RecallDeps;
export let webhooksEpisodeId: string;
export let unrelatedEpisodeId: string;
export let substrateId: string;

export async function push(
  observation: string,
  now: Date,
  identity: string = WRITE_SESSION,
): Promise<string> {
  const result = await handleReflection(
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
    { observations: [observation] },
    { identity, now },
  );
  // Intake queues the embedding rather than performing it, so the fixture runs the row the
  // worker would run: what these files assert on is vector search, which needs the vectors.
  await drainAcceptedVectors(harness.driver, provider);
  return result.episode_id;
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-recall-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'debug' });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  // Startup publishes the readiness contract before anything can be accepted, and intake writes
  // each source's inventory from it. A source accepted with none records an inventory obligation
  // instead, and a session holding one cannot be counted at all — so the pack below would report
  // no pending count rather than the wrong one.
  publishReadinessPolicy(
    db,
    { pipelineVersion: PIPELINE_VERSION, stageNames: REQUIRED_STAGES, transferCapabilities: [] },
    new Date('2026-01-01T00:00:00.000Z'),
  );

  const backbone = await bootstrapBackbone(harness.driver, { memberName: 'Ryan Huber' });
  substrateId = requireSubstrate(backbone).id;
  sessions = new SessionManager(harness.driver, {
    memberId: backbone.member.id,
    workspaceId: backbone.workspace.id,
  });

  deps = {
    driver: harness.driver,
    db,
    sessions,
    provider,
    config: config(),
    cueCache: new CueCache(),
    logger,
  };

  // The unrelated episode is stored first so the recency strategy ranks the webhooks one
  // ahead of it, which keeps the unrelated episode out of every seed list.
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
