import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { bootstrapBackbone } from '../../infrastructure/graph/backbone.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import {
  nodeProperties,
  turnsOfEpisode,
} from '../../infrastructure/graph/test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger, type Logger } from '../../infrastructure/logging/logger.js';
import { OllamaProvider } from '../../infrastructure/providers/ollama-provider.js';
import { ReflectionQueueClaimant } from '../../infrastructure/sqlite/claim.js';
import { openSqliteHandle, type SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { getLedgerEntry } from '../../infrastructure/sqlite/ops-ledger.js';
import {
  enqueueReflectionJob,
  getReflectionJob,
  listReflectionJobs,
} from '../../infrastructure/sqlite/reflection-queue.js';
import { SessionManager } from '../../session/session-manager.js';
import type { StageContext, StageOutcome } from '../domain/stage.js';
import { ReflectionDispatch } from './dispatch.js';
import { handleReflection, INTEGRATE_JOB_TYPE, type ReflectionIntakeDeps } from './intake.js';
import { orchestratorLedgerKey, ReflectionOrchestrator } from './orchestrator.js';
import { findPendingVectorNodes } from './vectors.js';
import { ReflectionWorker, type ReflectionWorkerOptions } from './worker.js';

/**
 * The worker against the real substrate: a signal starts a job with nothing polling for it,
 * a start drains what an outage and a crash left behind, and five failures pause the loop
 * until the cooldown lets it back in.
 */
const EMBED_DIMENSION = DEFAULTS.models.embedDimension;
const OLLAMA_URL = process.env.AION_OLLAMA_URL ?? 'http://127.0.0.1:11434';
const DEAD_OLLAMA_URL = 'http://127.0.0.1:9';

const SIGNAL_IDENTITY = 'worker-signal-session';
const DRAIN_IDENTITY = 'worker-drain-session';
const RECLAIM_IDENTITY = 'worker-reclaim-session';
const BREAKER_IDENTITY = 'worker-breaker-session';

const SIGNAL_PAYLOAD = {
  turns: [
    { role: 'user', text: 'the reflection worker has to start without a poll tick' },
    { role: 'assistant', text: 'the dispatch signal is what starts it' },
  ],
  summary: 'event-driven reflection',
};

const DRAIN_PAYLOAD = {
  turns: [
    { role: 'user', text: 'ollama was down when this episode was pushed' },
    { role: 'assistant', text: 'the episode stored anyway and the vectors waited' },
  ],
  summary: 'an episode stored through an inference outage',
};

const RECLAIM_PAYLOAD = {
  turns: [
    { role: 'user', text: 'the process died holding this job' },
    { role: 'assistant', text: 'the stale claim comes back on the next start' },
  ],
  summary: 'a job a crash left claimed',
};

const BREAKER_PAYLOAD = {
  turns: [
    { role: 'user', text: 'five consecutive failures should pause the worker' },
    { role: 'assistant', text: 'and the cooldown should let it back in' },
  ],
  summary: 'circuit breaker behaviour',
};

/** One stage whose outcome the test controls, so a run's success is not a model's opinion. */
class RecordingStage {
  readonly name = 'recording';
  readonly episodes: string[] = [];
  mode: 'ok' | 'fail' = 'ok';
  readonly #waiting: Array<{ readonly count: number; readonly resolve: () => void }> = [];

  /** Resolves the moment the stage has been entered `count` times, so no test waits on a clock. */
  entered(count: number): Promise<void> {
    if (this.episodes.length >= count) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.#waiting.push({ count, resolve });
    });
  }

  async run(ctx: StageContext): Promise<StageOutcome> {
    this.episodes.push(ctx.episodeId);
    for (const waiter of [...this.#waiting]) {
      if (this.episodes.length >= waiter.count) {
        waiter.resolve();
      }
    }
    if (this.mode === 'fail') {
      return { status: 'failed', summary: 'the stage refused' };
    }
    return { status: 'ok', summary: `recorded ${ctx.episode.turns.length} turns`, counts: { entities: 1 } };
  }
}

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let logger: Logger;
let dispatch: ReflectionDispatch;
let live: ReflectionIntakeDeps;
let deadOllama: ReflectionIntakeDeps;
let worker: ReflectionWorker | undefined;

function buildWorker(stage: RecordingStage, options: ReflectionWorkerOptions = {}): ReflectionWorker {
  const runner = new ReflectionOrchestrator(
    { driver: harness.driver, db, provider: live.provider, logger },
    [stage],
  );
  worker = new ReflectionWorker(
    { driver: harness.driver, db, provider: live.provider, dispatch, runner, logger },
    options,
  );
  return worker;
}

/** A crashed process's row: claimed, and older than the drain's stale timeout. */
function backdateClaim(jobId: string, ageMs: number): void {
  db.prepare('UPDATE reflection_queue SET claimed_at = ? WHERE id = ?').run(
    new Date(Date.now() - ageMs).toISOString(),
    jobId,
  );
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-worker-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  const backbone = await bootstrapBackbone(harness.driver, { memberName: 'Test User' });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' });
  dispatch = new ReflectionDispatch();

  live = {
    driver: harness.driver,
    db,
    sessions: new SessionManager(harness.driver, {
      memberId: backbone.member.id,
      workspaceId: backbone.workspace.id,
    }),
    provider: new OllamaProvider({ baseUrl: OLLAMA_URL, embedModel: DEFAULTS.models.embed }),
    dispatch,
    logger,
    entropyThreshold: DEFAULTS.redaction.entropyThreshold,
  };
  deadOllama = {
    ...live,
    provider: new OllamaProvider({ baseUrl: DEAD_OLLAMA_URL, embedModel: DEFAULTS.models.embed }),
  };
}, 300_000);

afterEach(async () => {
  await worker?.stop();
  worker = undefined;
});

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('a reflection signalled while the worker is listening', () => {
  it('runs the pipeline without anything having polled for the job', async () => {
    const stage = new RecordingStage();
    const started = buildWorker(stage);
    const drain = await started.start();

    const stored = await handleReflection(live, SIGNAL_PAYLOAD, { identity: SIGNAL_IDENTITY });
    await started.whenIdle();

    expect(drain).toEqual({ reclaimed: 0, vectored: 0, ran: 0 });
    expect(stage.episodes).toEqual([stored.episode_id]);
    expect(listReflectionJobs(db)).toEqual([]);

    const recorded = getLedgerEntry(db, orchestratorLedgerKey(stored.episode_id));
    expect(recorded?.summary).toMatchObject({ counts: { entities: 1 } });
  });
});

describe('a start after an outage and a crash', () => {
  it('embeds what was left pending and runs the row nothing ever claimed', async () => {
    const stored = await handleReflection(deadOllama, DRAIN_PAYLOAD, { identity: DRAIN_IDENTITY });
    const pendingBefore = await findPendingVectorNodes(harness.driver, 50);
    expect(pendingBefore.map((node) => node.id)).toContain(stored.episode_id);

    const stage = new RecordingStage();
    const drain = await buildWorker(stage).start();

    expect(drain.vectored).toBe(pendingBefore.length);
    expect(drain.ran).toBe(1);
    expect(stage.episodes).toEqual([stored.episode_id]);
    expect(await findPendingVectorNodes(harness.driver, 50)).toEqual([]);

    const vector = (await nodeProperties(harness.driver, stored.episode_id)).content_vec;
    expect(vector).toHaveLength(EMBED_DIMENSION);
    expect((await turnsOfEpisode(harness.driver, stored.episode_id)).length).toBe(2);
    expect(listReflectionJobs(db)).toEqual([]);
  });

  it('reclaims a job a dead process was holding and the ledger makes the re-run a no-op', async () => {
    const stage = new RecordingStage();
    const first = buildWorker(stage);
    const stored = await handleReflection(live, RECLAIM_PAYLOAD, { identity: RECLAIM_IDENTITY });
    await first.start();
    expect(stage.episodes).toEqual([stored.episode_id]);
    await first.stop();

    const abandoned = enqueueReflectionJob(db, INTEGRATE_JOB_TYPE, { episode_id: stored.episode_id });
    new ReflectionQueueClaimant('dead-process').claimNext(db);
    backdateClaim(abandoned, 11 * 60 * 1000);

    const drain = await buildWorker(stage).start();

    expect(drain.reclaimed).toBe(1);
    expect(drain.ran).toBe(1);
    // The ledger key the first run wrote gates the pipeline, so the reclaimed job costs one
    // SQLite read and the stage never sees the episode a second time.
    expect(stage.episodes).toEqual([stored.episode_id]);
    expect(getReflectionJob(db, abandoned)).toBeUndefined();
  });
});

describe('five consecutive failures', () => {
  it('pauses claiming, then resumes when the cooldown is up', async () => {
    const stage = new RecordingStage();
    stage.mode = 'fail';
    const started = buildWorker(stage, { retryBaseMs: 60_000, breakerCooldownMs: 50 });

    const episodeId = (await handleReflection(live, BREAKER_PAYLOAD, { identity: BREAKER_IDENTITY }))
      .episode_id;
    const later = [1, 2, 3, 4, 5].map(() =>
      enqueueReflectionJob(db, INTEGRATE_JOB_TYPE, { episode_id: episodeId }),
    );
    const drain = await started.start();

    expect(drain.ran).toBe(5);
    expect(started.paused).toBe(true);
    expect(getReflectionJob(db, later[4] as string)?.claimedAt).toBeNull();
    expect(getLedgerEntry(db, orchestratorLedgerKey(episodeId))).toBeUndefined();

    stage.mode = 'ok';
    await stage.entered(6);
    await started.whenIdle();

    expect(started.paused).toBe(false);
    expect(stage.episodes).toHaveLength(6);
    expect(getLedgerEntry(db, orchestratorLedgerKey(episodeId))?.summary).toMatchObject({
      counts: { entities: 1 },
    });
  });
});
