import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deadLetterOperation } from './dead-letter.js';
import { EvidenceResolver } from '../../../evidence/application/resolver.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import type { Config } from '../../../infrastructure/config/schema.js';
import { openLogger, type Logger } from '../../../infrastructure/logging/logger.js';
import { refusingProvider } from '../../../infrastructure/providers/test-support/refusing-provider.fixture.js';
import { SqliteStore } from '../../../infrastructure/sqlite/database.js';
import { countDeadLetterAttention } from '../../../infrastructure/sqlite/dead-letter-queue.js';
import {
  enqueueReflectionJob,
  getReflectionJob,
} from '../../../infrastructure/sqlite/reflection-queue.js';
import type { ReflectionIntakeDeps } from '../../../reflection/application/intake.js';
import { INTEGRATE_JOB_TYPE } from '../../../reflection/application/intake.js';
import type { ReflectionRun } from '../../../reflection/application/orchestrator.js';
import { ReflectionWorker } from '../../../reflection/application/worker.js';
import { directCompletionPublisher } from '../../../reflection/test-support/direct-intake.fixture.js';
import { FakeGraph } from '../../../reflection/test-support/fake-graph.fixture.js';
import type { OperationContext } from '../../domain/operation.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';

/**
 * The recovery loop with its real parts: the reflection worker exhausting a job, and
 * `dead_letter` deciding on its own whether the job gets another cycle. Nothing here requeues a
 * row by hand or answers a prompt; the only moves the test makes are the ones a deployment
 * makes, which is running a different build.
 */

const EPISODE_ID = 'episode-a-bug-kept-failing';
const MAX_ATTEMPTS = 2;

/** Fails every run until the build carrying the fix is the one running. */
class BuildBoundRunner {
  calls = 0;

  async run(episodeId: string): Promise<ReflectionRun> {
    await Promise.resolve();
    this.calls += 1;
    if (process.env.AION_BUILD_SHA !== 'build-with-the-fix') {
      throw new Error('entities stage threw on this episode');
    }
    return {
      episodeId,
      status: 'completed',
      applied: true,
      summary: { episodeId, durationMs: 1, stages: [], counts: {}, skippedStages: [] },
    };
  }
}

let dir: string;
let store: SqliteStore;
let graph: FakeGraph;
let logger: Logger;
let worker: ReflectionWorker | undefined;

const config: Config = {
  ...DEFAULTS,
  operational: { ...DEFAULTS.operational, workerMaxAttempts: MAX_ATTEMPTS },
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-dead-letter-recovery-'));
  store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  graph = new FakeGraph();
  logger = openLogger({ filePath: join(dir, 'aion.jsonl'), level: 'fatal' });
  woken.length = 0;
  vi.stubEnv('AION_BUILD_SHA', 'build-with-the-bug');
});

afterEach(async () => {
  const current = worker;
  worker = undefined;
  await current?.stop();
  vi.unstubAllEnvs();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function startWorker(runner: BuildBoundRunner): ReflectionWorker {
  worker = new ReflectionWorker(
    {
      driver: graph.driver,
      db: store.db,
      provider: refusingProvider,
      runner,
      logger,
      publications: directCompletionPublisher(graph.driver, store.db),
      resolver: new EvidenceResolver({
        driver: graph.driver,
        db: store.db,
        logger: { warn: () => undefined },
      }),
    },
    // A breaker that never trips inside the test: the subject is the attempt ceiling.
    { retryBaseMs: 1, retryCapMs: 1, maxAttempts: MAX_ATTEMPTS, breakerThreshold: 1_000 },
  );
  return worker;
}

/** Every wakeup `dead_letter` sent the worker, by job. */
const woken: string[] = [];

/** The maintenance loop's view of the substrate, with the worker's own wake hook as intake's. */
function ctxFor(running: ReflectionWorker): OperationContext {
  const intake = {
    onJobEnqueued: (jobId: string): void => {
      woken.push(jobId);
      running.wake();
    },
  } as ReflectionIntakeDeps;
  return {
    driver: graph.driver,
    db: store.db,
    config,
    logger,
    provider: refusingProvider,
    intake,
    health: healthFixture(),
    now: new Date(),
    signal: new AbortController().signal,
  };
}

async function exhausted(running: ReflectionWorker, jobId: string): Promise<void> {
  await vi.waitFor(() => {
    const job = getReflectionJob(store.db, jobId);
    expect(job?.attempts).toBe(MAX_ATTEMPTS);
    expect(job?.claimedAt).toBeNull();
  });
  await running.whenIdle();
}

describe('an exhausted reflection job and dead_letter', () => {
  it('holds a repeating failure visibly, then completes the job on its own once a fixed build runs', async () => {
    const runner = new BuildBoundRunner();
    const running = startWorker(runner);
    const jobId = enqueueReflectionJob(store.db, INTEGRATE_JOB_TYPE, { episode_id: EPISODE_ID });
    await running.start();
    await exhausted(running, jobId);

    // The first exhaustion always gets a cycle, and it fails the same way.
    await deadLetterOperation().run(ctxFor(running));
    await exhausted(running, jobId);
    expect(runner.calls).toBe(2 * MAX_ATTEMPTS);

    // Nothing has changed, so nothing runs: pass after pass, the row stays queued and counted.
    const held = [
      await deadLetterOperation().run(ctxFor(running)),
      await deadLetterOperation().run(ctxFor(running)),
    ];
    await running.whenIdle();
    expect(held.map((pass) => pass.status)).toEqual(['noop', 'noop']);
    expect(runner.calls).toBe(2 * MAX_ATTEMPTS);
    expect(getReflectionJob(store.db, jobId)?.lastError).toBe(
      'entities stage threw on this episode',
    );
    expect(countDeadLetterAttention(store.db, MAX_ATTEMPTS)).toBe(1);

    // The deployment is the only move: a build carrying the fix starts running.
    vi.stubEnv('AION_BUILD_SHA', 'build-with-the-fix');
    const reconsidered = await deadLetterOperation().run(ctxFor(running));

    expect(reconsidered.itemsAffected).toBe(1);
    await vi.waitFor(() => {
      expect(getReflectionJob(store.db, jobId)).toBeUndefined();
    });
    await running.whenIdle();
    expect(runner.calls).toBe(2 * MAX_ATTEMPTS + 1);
    expect(countDeadLetterAttention(store.db, MAX_ATTEMPTS)).toBe(0);
    // Two cycles granted, each one announced to the worker; nothing else woke it for this row.
    expect(woken).toEqual([jobId, jobId]);
  });
});
