import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { handleReflection, type ReflectionIntakeDeps } from './intake.js';
import { LaneAssigner } from './lanes.js';
import { ReflectionOrchestrator } from './orchestrator.js';
import { reconcileEnrichment } from './reconcile.js';
import { ReflectionWorker } from './worker.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { bootstrapBackbone } from '../../infrastructure/graph/backbone.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger, type Logger } from '../../infrastructure/logging/logger.js';
import { OllamaProvider } from '../../infrastructure/providers/ollama-provider.js';
import { openSqliteHandle, type SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { listReflectionJobs } from '../../infrastructure/sqlite/reflection-queue.js';
import { SessionManager } from '../../session/session-manager.js';
import type { ReflectionStage, StageContext, StageOutcome } from '../domain/stage.js';

/**
 * The live incident, reproduced small: a bulk load queued ahead of a live turn, and the
 * episodes an operator's purge left stored but unenriched. Both were measured against the
 * real substrate that night; both are asserted here against a throwaway one.
 */
const EMBED_DIMENSION = DEFAULTS.models.embedDimension;
const OLLAMA_URL = process.env.AION_OLLAMA_URL ?? 'http://127.0.0.1:11434';

const FLOOD_SIZE = 20;
const FLOOD_IDENTITY = 'lane-flood-session';
const LIVE_IDENTITY = 'lane-live-session';
const ORPHAN_IDENTITY = 'lane-orphan-session';

/** Records the order the pipeline actually reached episodes in. No model call. */
class RecordingStage implements ReflectionStage {
  readonly name = 'recording';
  readonly episodes: string[] = [];

  run(ctx: StageContext): Promise<StageOutcome> {
    this.episodes.push(ctx.episodeId);
    return Promise.resolve({ status: 'ok', summary: 'recorded', counts: { entities: 1 } });
  }
}

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let logger: Logger;
let intake: ReflectionIntakeDeps;
let worker: ReflectionWorker | undefined;

function buildWorker(stage: ReflectionStage): ReflectionWorker {
  const runner = new ReflectionOrchestrator(
    { driver: harness.driver, db, provider: intake.provider, logger },
    [stage],
  );
  worker = new ReflectionWorker({
    driver: harness.driver,
    db,
    provider: intake.provider,
    runner,
    logger,
  });
  return worker;
}

function episodePayload(label: string): Record<string, unknown> {
  return {
    observations: [`episode ${label} of the lane priority exercise`],
    summary: `lane exercise ${label}`,
  };
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-lanes-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  const backbone = await bootstrapBackbone(harness.driver, { memberName: 'Test User' });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' });
  intake = {
    driver: harness.driver,
    db,
    sessions: new SessionManager(harness.driver, {
      memberId: backbone.member.id,
      workspaceId: backbone.workspace.id,
    }),
    provider: new OllamaProvider({ baseUrl: OLLAMA_URL, embedModel: DEFAULTS.models.embed }),
    // Late-bound on purpose: the worker under test is rebuilt per case, and intake wakes
    // whichever one is current.
    onJobEnqueued: () => {
      worker?.wake();
    },
    logger,
    entropyThreshold: DEFAULTS.redaction.entropyThreshold,
    lanes: new LaneAssigner(DEFAULTS.lanes),
    workerMaxAttempts: DEFAULTS.operational.workerMaxAttempts,
  };
}, 300_000);

afterEach(async () => {
  const current = worker;
  worker = undefined;
  await current?.stop();
});

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('a bulk-flagged flood ahead of one live turn', () => {
  it('enriches the live episode first and drains the flood behind it', async () => {
    for (let index = 0; index < FLOOD_SIZE; index += 1) {
      const flooded = await handleReflection(
        intake,
        { ...episodePayload(`bulk-${String(index)}`), lane: 'bulk' },
        { identity: FLOOD_IDENTITY },
      );
      expect(flooded.lane).toBe('bulk');
    }

    const live = await handleReflection(intake, episodePayload('live'), {
      identity: LIVE_IDENTITY,
    });
    expect(live.lane).toBe('interactive');

    const queued = listReflectionJobs(db);
    expect(queued).toHaveLength(FLOOD_SIZE + 1);
    expect(queued.filter((job) => job.lane === 'bulk')).toHaveLength(FLOOD_SIZE);

    const stage = new RecordingStage();
    const started = buildWorker(stage);
    await started.start();
    await started.whenIdle();

    // The live episode was pushed last and enriched first: the whole point of the lane.
    expect(stage.episodes[0]).toBe(live.episode_id);
    expect(stage.episodes).toHaveLength(FLOOD_SIZE + 1);
    expect(listReflectionJobs(db)).toEqual([]);
  }, 300_000);
});

describe('reconciling episodes nothing will ever enrich', () => {
  it('finds a hand-orphaned episode, leaves the enriched ones alone, and re-enqueues it', async () => {
    const orphan = await handleReflection(intake, episodePayload('orphan'), {
      identity: ORPHAN_IDENTITY,
    });

    // The operator's triage, reproduced: the queue row is purged and the episode stays in the
    // graph, stored and vectored, with no ledger key and nothing left to produce one.
    db.prepare('DELETE FROM reflection_queue').run();

    const counted = await reconcileEnrichment(harness.driver, db);

    expect(counted.unenriched).toBe(1);
    expect(counted.queued).toBe(0);
    expect(counted.enriched).toBe(FLOOD_SIZE + 1);
    expect(counted.reEnqueued).toBe(0);
    expect(listReflectionJobs(db)).toEqual([]);

    const repaired = await reconcileEnrichment(harness.driver, db, { reEnqueue: true });

    expect(repaired.reEnqueued).toBe(1);
    const requeued = listReflectionJobs(db);
    expect(requeued).toHaveLength(1);
    // A backfill of episodes that have already waited must not push ahead of a live turn.
    expect(requeued[0]).toMatchObject({ lane: 'bulk', sessionId: ORPHAN_IDENTITY });
    expect(requeued[0]?.payload).toEqual({ episode_id: orphan.episode_id });

    const afterRepair = await reconcileEnrichment(harness.driver, db);
    expect(afterRepair).toMatchObject({ unenriched: 0, queued: 1 });
  }, 300_000);

  it('counts nothing once the re-enqueued job has run', async () => {
    const stage = new RecordingStage();
    const started = buildWorker(stage);
    await started.start();
    await started.whenIdle();

    const report = await reconcileEnrichment(harness.driver, db);

    expect(report).toMatchObject({ unenriched: 0, queued: 0 });
    expect(report.enriched).toBe(report.episodes);
  }, 300_000);
});
