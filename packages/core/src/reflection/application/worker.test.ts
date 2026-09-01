import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { INTEGRATE_JOB_TYPE } from './intake.js';
import type { ReflectionRun, ReflectionRunOptions } from './orchestrator.js';
import { backoffDelayMs, ReflectionWorker, type ReflectionWorkerOptions } from './worker.js';
import { MEMORY_PROPERTIES } from '../../infrastructure/graph/episodes.js';
import { openLogger, type Logger } from '../../infrastructure/logging/logger.js';
import type { Provider, Vector } from '../../infrastructure/providers/types.js';
import { ReflectionQueueClaimant } from '../../infrastructure/sqlite/claim.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { listEnrichmentLagSamplesMs } from '../../infrastructure/sqlite/lag-samples.js';
import {
  enqueueReflectionJob,
  getReflectionJob,
} from '../../infrastructure/sqlite/reflection-queue.js';
import { FakeGraph } from '../test-support/fake-graph.fixture.js';

const EPISODE_ID = 'episode-under-reflection';

/** Resolves once the runner has been entered `target` times, so no test waits on a clock. */
class RunLatch {
  readonly reached: Promise<void>;
  #resolve: () => void = () => {
    // Replaced synchronously below: the Promise executor runs before the constructor returns.
  };
  #entered = 0;

  constructor(private readonly target: number) {
    this.reached = new Promise<void>((resolve) => {
      this.#resolve = resolve;
    });
  }

  tick(): void {
    this.#entered += 1;
    if (this.#entered >= this.target) {
      this.#resolve();
    }
  }
}

function completedRun(episodeId: string, applied: boolean): ReflectionRun {
  return {
    episodeId,
    status: 'completed',
    applied,
    summary: { episodeId, durationMs: 1, stages: [], counts: {}, skippedStages: [] },
  };
}

class StubRunner {
  readonly episodeIds: string[] = [];
  readonly runOptions: (ReflectionRunOptions | undefined)[] = [];
  outcome: (episodeId: string, call: number) => ReflectionRun = (episodeId) =>
    completedRun(episodeId, true);

  constructor(private readonly latch?: RunLatch) {}

  /** Yields first, so the worker has registered the run before the outcome is decided. */
  async run(episodeId: string, options?: ReflectionRunOptions): Promise<ReflectionRun> {
    await Promise.resolve();
    this.episodeIds.push(episodeId);
    this.runOptions.push(options);
    this.latch?.tick();
    return this.outcome(episodeId, this.episodeIds.length);
  }
}

class StubProvider implements Provider {
  readonly embedded: string[][] = [];

  async embed(texts: string[]): Promise<Vector[]> {
    this.embedded.push([...texts]);
    return texts.map((_, index) => [index, 0.5, 0.25]);
  }

  async generate(): Promise<unknown> {
    throw new Error('the worker never generates');
  }
}

let dir: string;
let store: SqliteStore;
let graph: FakeGraph;
let provider: StubProvider;
let logger: Logger;
let worker: ReflectionWorker | undefined;

function build(runner: StubRunner, options: ReflectionWorkerOptions = {}): ReflectionWorker {
  worker = new ReflectionWorker(
    { driver: graph.driver, db: store.db, provider, runner, logger },
    options,
  );
  return worker;
}

function enqueue(episodeId: string = EPISODE_ID): string {
  return enqueueReflectionJob(store.db, INTEGRATE_JOB_TYPE, { episode_id: episodeId });
}

/** What intake does on a fresh enqueue. The wakeup carries no job; the claim loop reads the queue. */
function signal(): void {
  worker?.wake();
}

/** A crashed process's row: claimed, and old enough that the drain's timeout has passed. */
function backdateClaim(jobId: string, ageMs: number): void {
  store.db
    .prepare('UPDATE reflection_queue SET claimed_at = ? WHERE id = ?')
    .run(new Date(Date.now() - ageMs).toISOString(), jobId);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-worker-'));
  store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  graph = new FakeGraph();
  provider = new StubProvider();
  logger = openLogger({ filePath: join(dir, 'aion.jsonl'), level: 'fatal' });
});

afterEach(async () => {
  const current = worker;
  worker = undefined;
  await current?.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('retry backoff curve', () => {
  it('doubles from the base and never passes the cap', () => {
    expect(backoffDelayMs(1, 5000, 300_000)).toBe(5000);
    expect(backoffDelayMs(2, 5000, 300_000)).toBe(10_000);
    expect(backoffDelayMs(3, 5000, 300_000)).toBe(20_000);
    expect(backoffDelayMs(4, 5000, 300_000)).toBe(40_000);
    expect(backoffDelayMs(20, 5000, 300_000)).toBe(300_000);
  });
});

describe('signal-driven execution', () => {
  it('runs the job the signal announces and installs no timer to find it', async () => {
    const runner = new StubRunner();
    const started = build(runner);
    await started.start();

    const interval = vi.spyOn(globalThis, 'setInterval');
    const timeout = vi.spyOn(globalThis, 'setTimeout');
    const jobId = enqueue();
    signal();
    await started.whenIdle();

    expect(runner.episodeIds).toEqual([EPISODE_ID]);
    expect(getReflectionJob(store.db, jobId)).toBeUndefined();
    expect(interval).not.toHaveBeenCalled();
    expect(timeout).not.toHaveBeenCalled();

    interval.mockRestore();
    timeout.mockRestore();
  });

  /**
   * The run clock is the wall clock in live operation and a value the caller supplies, which
   * is what leaves an elapsed-time decision inside a stage measuring real elapsed time. A
   * replay supplies its own reading of the same wall clock; the episode's own clock reaches
   * the pipeline through the episode node, never through here.
   */
  it('runs the episode on the clock it was given rather than one it reads itself', async () => {
    const runner = new StubRunner();
    const dequeued = new Date('2026-07-04T09:15:00.000Z');
    const started = build(runner, { clock: () => dequeued });
    await started.start();

    enqueue();
    signal();
    await started.whenIdle();

    expect(runner.runOptions).toEqual([{ now: dequeued }]);
  });

  it('runs one job at a time at the default worker count', async () => {
    const runner = new StubRunner();
    let peak = 0;
    const started = build(runner);
    runner.outcome = (episodeId): ReflectionRun => {
      peak = Math.max(peak, started.inFlight);
      return completedRun(episodeId, true);
    };
    await started.start();

    enqueue('episode-a');
    enqueue('episode-b');
    signal();
    await started.whenIdle();

    expect(runner.episodeIds).toEqual(['episode-a', 'episode-b']);
    expect(peak).toBe(1);
  });

  it('completes a terminal run that enriched nothing rather than retrying it', async () => {
    const runner = new StubRunner();
    runner.outcome = (episodeId): ReflectionRun => ({
      episodeId,
      status: 'already_applied',
      applied: false,
      summary: { episodeId, durationMs: 1, stages: [], counts: {}, skippedStages: [] },
    });
    const started = build(runner);
    await started.start();

    const jobId = enqueue();
    signal();
    await started.whenIdle();

    expect(getReflectionJob(store.db, jobId)).toBeUndefined();
    expect(started.retrying).toBe(0);
  });
});

describe('enrichment lag', () => {
  function backdateEnqueue(jobId: string, ageMs: number): void {
    store.db
      .prepare('UPDATE reflection_queue SET enqueued_at = ? WHERE id = ?')
      .run(new Date(Date.now() - ageMs).toISOString(), jobId);
  }

  it('records a sample for a run that actually enriched the episode', async () => {
    const runner = new StubRunner();
    const started = build(runner);
    await started.start();

    const jobId = enqueue();
    backdateEnqueue(jobId, 5_000);
    signal();
    await started.whenIdle();

    const samples = listEnrichmentLagSamplesMs(store.db);
    expect(samples).toHaveLength(1);
    // Loose bound: real wall time passes running the test, backoff and timers are not at play.
    expect(samples[0]).toBeGreaterThanOrEqual(5_000);
    expect(samples[0]).toBeLessThan(6_000);
  });

  // `already_applied` and `episode_unavailable` are terminal but enriched nothing new; a
  // sample here would understate the lag the p95 exists to catch.
  it('records nothing for a terminal run that enriched nothing', async () => {
    const runner = new StubRunner();
    runner.outcome = (episodeId): ReflectionRun => ({
      episodeId,
      status: 'already_applied',
      applied: false,
      summary: { episodeId, durationMs: 1, stages: [], counts: {}, skippedStages: [] },
    });
    const started = build(runner);
    await started.start();

    enqueue();
    signal();
    await started.whenIdle();

    expect(listEnrichmentLagSamplesMs(store.db)).toEqual([]);
  });
});

describe('startup drain', () => {
  it('reclaims a dead process claim, attaches pending vectors, then runs the queue empty', async () => {
    graph.seedNode('mem-pending', ['Episode', 'AionNode', 'Memory'], {
      [MEMORY_PROPERTIES.text]: 'an episode the outage left unvectorized',
    });
    const abandoned = enqueue();
    new ReflectionQueueClaimant('dead-process').claimNext(store.db);
    backdateClaim(abandoned, 11 * 60 * 1000);

    const runner = new StubRunner();
    const drain = await build(runner).start();

    expect(drain).toEqual({ reclaimed: 1, vectored: 1, ran: 1 });
    expect(provider.embedded).toEqual([['an episode the outage left unvectorized']]);
    expect(graph.nodes.get('mem-pending')?.properties[MEMORY_PROPERTIES.contentVector]).toEqual([
      0, 0.5, 0.25,
    ]);
    expect(runner.episodeIds).toEqual([EPISODE_ID]);
    expect(getReflectionJob(store.db, abandoned)).toBeUndefined();
  });

  it('runs a never-claimed legacy row that no signal will ever arrive for', async () => {
    const legacy = enqueue('legacy-episode');
    const runner = new StubRunner();

    const drain = await build(runner).start();

    expect(drain.ran).toBe(1);
    expect(runner.episodeIds).toEqual(['legacy-episode']);
    expect(getReflectionJob(store.db, legacy)).toBeUndefined();
  });

  it('runs the queue even when the pending vectors cannot be embedded', async () => {
    graph.seedNode('mem-pending', ['Episode', 'AionNode', 'Memory'], {
      [MEMORY_PROPERTIES.text]: 'still unvectorized',
    });
    vi.spyOn(provider, 'embed').mockRejectedValue(new Error('ollama is down'));
    const jobId = enqueue();
    const runner = new StubRunner();

    const drain = await build(runner).start();

    expect(drain.vectored).toBe(0);
    expect(drain.ran).toBe(1);
    expect(getReflectionJob(store.db, jobId)).toBeUndefined();
  });

  it('leaves a claim younger than the timeout with its owner', async () => {
    const held = enqueue();
    new ReflectionQueueClaimant('live-process').claimNext(store.db);
    const runner = new StubRunner();

    const drain = await build(runner).start();

    expect(drain).toEqual({ reclaimed: 0, vectored: 0, ran: 0 });
    expect(getReflectionJob(store.db, held)?.claimedBy).toBe('live-process');
  });
});

describe('retry with backoff', () => {
  it('holds the claim through the delay, then releases it and runs again', async () => {
    const latch = new RunLatch(2);
    const runner = new StubRunner(latch);
    runner.outcome = (episodeId, call): ReflectionRun => {
      if (call === 1) {
        throw new Error('the reflect model timed out');
      }
      return completedRun(episodeId, true);
    };
    const started = build(runner, { retryBaseMs: 5 });

    const jobId = enqueue();
    await started.start();

    const held = getReflectionJob(store.db, jobId);
    expect(held?.claimedBy).toBe(started.claimantId);
    expect(held?.attempts).toBe(0);
    expect(started.retrying).toBe(1);

    await latch.reached;
    await started.whenIdle();

    expect(runner.episodeIds).toEqual([EPISODE_ID, EPISODE_ID]);
    expect(getReflectionJob(store.db, jobId)).toBeUndefined();
    expect(started.retrying).toBe(0);
  });

  it('treats a completed run that enriched nothing as a failure worth retrying', async () => {
    const runner = new StubRunner();
    runner.outcome = (episodeId): ReflectionRun => completedRun(episodeId, false);
    const started = build(runner, { retryBaseMs: 60_000 });

    const jobId = enqueue();
    await started.start();

    expect(started.retrying).toBe(1);
    expect(getReflectionJob(store.db, jobId)?.claimedBy).toBe(started.claimantId);
  });

  it('parks a job that spent its attempts and never claims it again', async () => {
    const latch = new RunLatch(2);
    const runner = new StubRunner(latch);
    runner.outcome = (): ReflectionRun => {
      throw new Error('the graph rejected the write');
    };
    const started = build(runner, { retryBaseMs: 1, maxAttempts: 2 });

    const jobId = enqueue();
    await started.start();
    await latch.reached;
    await started.whenIdle();

    const parked = getReflectionJob(store.db, jobId);
    expect(parked?.attempts).toBe(2);
    expect(parked?.claimedAt).toBeNull();
    expect(parked?.lastError).toBe('the graph rejected the write');
    expect(started.retrying).toBe(0);

    signal();
    await started.whenIdle();

    expect(runner.episodeIds).toHaveLength(2);
  });

  it('fails a job whose payload names no episode', async () => {
    const runner = new StubRunner();
    const started = build(runner, { retryBaseMs: 60_000 });
    const jobId = enqueueReflectionJob(store.db, INTEGRATE_JOB_TYPE, { nothing: true });

    await started.start();

    expect(runner.episodeIds).toEqual([]);
    expect(started.retrying).toBe(1);
    expect(getReflectionJob(store.db, jobId)?.claimedBy).toBe(started.claimantId);
  });
});

describe('circuit breaker', () => {
  it('pauses claiming after five consecutive failures and resumes after the cooldown', async () => {
    const latch = new RunLatch(6);
    const runner = new StubRunner(latch);
    let failing = true;
    runner.outcome = (episodeId): ReflectionRun => {
      if (failing) {
        throw new Error('ollama refused the connection');
      }
      return completedRun(episodeId, true);
    };
    const started = build(runner, { retryBaseMs: 60_000, breakerCooldownMs: 10 });

    const jobIds = [1, 2, 3, 4, 5, 6].map((n) => enqueue(`episode-${n}`));
    await started.start();

    expect(runner.episodeIds).toHaveLength(5);
    expect(started.paused).toBe(true);
    expect(getReflectionJob(store.db, jobIds[5]!)?.claimedAt).toBeNull();

    failing = false;
    await latch.reached;
    await started.whenIdle();

    expect(started.paused).toBe(false);
    expect(runner.episodeIds[5]).toBe('episode-6');
    expect(getReflectionJob(store.db, jobIds[5]!)).toBeUndefined();
  });
});

describe('stop', () => {
  it('hands back every claim it holds and stops answering signals', async () => {
    const runner = new StubRunner();
    runner.outcome = (): ReflectionRun => {
      throw new Error('the reflect model timed out');
    };
    const started = build(runner, { retryBaseMs: 60_000 });

    const jobId = enqueue();
    await started.start();
    expect(started.retrying).toBe(1);

    await started.stop();

    const released = getReflectionJob(store.db, jobId);
    expect(released?.claimedAt).toBeNull();
    expect(released?.attempts).toBe(1);
    expect(released?.lastError).toBe('the reflect model timed out');
    expect(started.retrying).toBe(0);

    signal();
    await started.whenIdle();

    expect(runner.episodeIds).toHaveLength(1);
  });
});

/** The reaper's interval floor is one second, so a real-clock wait is the honest way to reach it. */
async function afterOneSweep(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 1_300);
  });
}

describe('stale-claim reaper', () => {
  it('reclaims a dead process claim without a restart, and runs the job', async () => {
    const runner = new StubRunner();
    // Zero stale window, so the claim is stale the moment the reaper looks; the interval
    // floor keeps the sweep off the event loop's hot path either way.
    const started = build(runner, { staleTimeoutMs: 0 });
    const drain = await started.start();

    // The startup drain is what a restart already covers; this test is about the sweep that
    // follows it. Both claims are planted after start() returns, since with a zero stale
    // window the drain is entitled to reclaim anything already sitting there.
    expect(drain.ran).toBe(0);
    const abandoned = enqueue();
    new ReflectionQueueClaimant('a-process-that-died').claimNext(store.db);
    const stranded = enqueue();
    new ReflectionQueueClaimant('a-second-dead-process').claimNext(store.db);
    expect(getReflectionJob(store.db, stranded)?.claimedBy).toBe('a-second-dead-process');

    await afterOneSweep();
    await started.whenIdle();

    expect(runner.episodeIds.length).toBeGreaterThan(0);
    expect(getReflectionJob(store.db, stranded)).toBeUndefined();
    expect(getReflectionJob(store.db, abandoned)).toBeUndefined();
  });

  it('never takes back a claim it is holding through a backoff', async () => {
    const runner = new StubRunner();
    runner.outcome = (): never => {
      throw new Error('the reflect model timed out');
    };
    const started = build(runner, { staleTimeoutMs: 0, retryBaseMs: 60_000 });
    await started.start();

    const jobId = enqueue();
    signal();
    await started.whenIdle();
    expect(started.retrying).toBe(1);

    await afterOneSweep();

    // Still parked on its backoff under this worker's own name: the sweep skipped it.
    expect(getReflectionJob(store.db, jobId)?.claimedBy).toBe(started.claimantId);
    expect(runner.episodeIds).toHaveLength(1);
  });
});
