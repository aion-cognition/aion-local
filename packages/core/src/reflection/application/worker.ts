import type { Driver } from 'neo4j-driver';

import { completionStages } from './completion-publication.js';
import { SourceIndexDrainer } from './index-drain.js';
import { INTEGRATE_JOB_TYPE } from './intake.js';
import type { ReflectionRun, ReflectionRunOptions } from './orchestrator.js';
import { drainPendingVectors } from './vectors.js';
import { describeFailedRun, episodeIdOf } from './worker-diagnostics.js';
import type { EvidenceResolver } from '../../evidence/application/resolver.js';
import { backoffDelayMs } from '../../infrastructure/backoff.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { errorMessage } from '../../infrastructure/errors.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { Provider } from '../../infrastructure/providers/types.js';
import type { PublicationOutcome } from '../../infrastructure/publication/types.js';
import {
  ReflectionQueueClaimant,
  reclaimStaleReflectionJobs,
} from '../../infrastructure/sqlite/claim.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { recordEnrichmentLagMs } from '../../infrastructure/sqlite/lag-samples.js';
import type { ReflectionJob } from '../../infrastructure/sqlite/reflection-queue.js';
import { halfWindowIntervalMs, SweepTimer } from '../../infrastructure/sweep-timer.js';

/**
 * Reflection is event-driven. A signal from intake starts a claim-and-run cycle immediately;
 * the queue row exists so a restart or a crash does not lose the job, not so a loop can
 * watch it. Nothing here polls for work: the worker's timers are the backoff delay of one
 * failed job, the circuit breaker's cooldown, and the stale-claim sweep, which is not a poll
 * for work but a reaper for another process's abandoned claims. A crash and the automatic
 * restart that follows it land seconds apart, well inside the stale window, so a sweep that
 * only ran at startup would find nothing and the episode would sit claimed by a dead process
 * until some later restart happened to fall more than one window after it.
 */

/**
 * The worker's pinned defaults, read from the catalog that names and ranges them. The service
 * threads the configured value over each; these are what a caller that threads nothing gets.
 */
export const DEFAULT_WORKER_COUNT = DEFAULTS.operational.workerCount;
export const DEFAULT_DRAIN_STALE_TIMEOUT_MS = DEFAULTS.operational.workerStaleClaimTimeoutMs;
export const DEFAULT_RETRY_BASE_MS = DEFAULTS.operational.workerRetryBaseMs;
export const DEFAULT_RETRY_CAP_MS = DEFAULTS.operational.workerRetryCapMs;
export const DEFAULT_MAX_ATTEMPTS = DEFAULTS.operational.workerMaxAttempts;
export const DEFAULT_BREAKER_THRESHOLD = DEFAULTS.operational.workerBreakerThreshold;
export const DEFAULT_BREAKER_COOLDOWN_MS = DEFAULTS.operational.workerBreakerCooldownMs;
export const DEFAULT_VECTOR_BATCH_SIZE = DEFAULTS.operational.workerVectorBatchSize;

/** `ReflectionOrchestrator` satisfies this; the worker never constructs the pipeline it drives. */
export type ReflectionRunner = {
  run(episodeId: string, options?: ReflectionRunOptions): Promise<ReflectionRun>;
};

export type ReflectionWorkerDeps = {
  readonly driver: Driver;
  readonly db: SqliteHandle;
  readonly provider: Provider;
  readonly runner: ReflectionRunner;
  readonly logger: Logger;
  /** Where a finished run settles what it owed. There is no second way to complete a job. */
  readonly publications: CompletionPublisher;
  /**
   * What the source-index drain reads a source through. Required: a composition without one
   * would leave the `source_index` rows an acceptance writes unclaimed forever, and every
   * source behind them eviction-pinned. A worker that cannot index says so at compile time.
   */
  readonly resolver: EvidenceResolver;
};

/** The one thing the worker asks of the coordinator: publish this run's settlement. */
export type CompletionPublisher = {
  publish(request: {
    readonly kind: 'reflection_completion';
    readonly operationId: string;
    readonly payload: unknown;
  }): Promise<PublicationOutcome>;
};

export type ReflectionWorkerOptions = {
  readonly workerCount?: number;
  readonly staleTimeoutMs?: number;
  readonly retryBaseMs?: number;
  readonly retryCapMs?: number;
  readonly maxAttempts?: number;
  readonly breakerThreshold?: number;
  readonly breakerCooldownMs?: number;
  readonly vectorBatchSize?: number;
  /**
   * Read once per job and handed to the run as its clock. The wall clock in live operation,
   * which is what keeps a stage's elapsed-time decision measuring real elapsed time; a test
   * or a replay supplies its own.
   */
  readonly clock?: () => Date;
};

export type ReflectionDrain = {
  /** Claims a dead process left behind, returned to the pool. */
  readonly reclaimed: number;
  /** `:Memory` nodes an earlier inference outage left without a content vector. */
  readonly vectored: number;
  /** Jobs this drain ran, whatever each of them made of its episode. */
  readonly ran: number;
  /** Search documents the index drain wrote for the sources whose rows it claimed. */
  readonly indexed: number;
};

const EMPTY_DRAIN: ReflectionDrain = { reclaimed: 0, vectored: 0, ran: 0, indexed: 0 };

/**
 * A second, well under the minutes-scale floor the idle sweeps use. This one reaps another
 * process's abandoned claims, and a test drives it on the real clock.
 */
const REAPER_MIN_INTERVAL_MS = 1_000;

type HeldRetry = {
  readonly timer: NodeJS.Timeout;
  readonly reason: string;
};

export { backoffDelayMs } from '../../infrastructure/backoff.js';
export { describeFailedRun } from './worker-diagnostics.js';

/** Claiming another kind of source work would spend its attempts failing it here. */
const RUNNABLE_JOB_TYPES: readonly string[] = [INTEGRATE_JOB_TYPE];

export class ReflectionWorker {
  readonly #deps: ReflectionWorkerDeps;
  readonly #claimant = new ReflectionQueueClaimant();
  readonly #workerCount: number;
  readonly #staleTimeoutMs: number;
  readonly #retryBaseMs: number;
  readonly #retryCapMs: number;
  readonly #maxAttempts: number;
  readonly #breakerThreshold: number;
  readonly #breakerCooldownMs: number;
  readonly #vectorBatchSize: number;
  readonly #clock: () => Date;

  /** Runs in flight. Its size is the pool occupancy the claim loop reads. */
  readonly #running = new Set<Promise<void>>();
  readonly #index: SourceIndexDrainer;
  /** Jobs whose claim this instance holds through a backoff delay, keyed by job id. */
  readonly #retries = new Map<string, HeldRetry>();
  #cooldown: NodeJS.Timeout | undefined;
  #reaper: SweepTimer | undefined;
  #consecutiveFailures = 0;
  #paused = false;
  #started = false;
  #stopped = false;
  #processed = 0;

  constructor(deps: ReflectionWorkerDeps, options: ReflectionWorkerOptions = {}) {
    this.#deps = deps;
    this.#workerCount = options.workerCount ?? DEFAULT_WORKER_COUNT;
    this.#staleTimeoutMs = options.staleTimeoutMs ?? DEFAULT_DRAIN_STALE_TIMEOUT_MS;
    this.#retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this.#retryCapMs = options.retryCapMs ?? DEFAULT_RETRY_CAP_MS;
    this.#maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.#breakerThreshold = options.breakerThreshold ?? DEFAULT_BREAKER_THRESHOLD;
    this.#breakerCooldownMs = options.breakerCooldownMs ?? DEFAULT_BREAKER_COOLDOWN_MS;
    this.#vectorBatchSize = options.vectorBatchSize ?? DEFAULT_VECTOR_BATCH_SIZE;
    this.#clock = options.clock ?? ((): Date => new Date());
    this.#index = new SourceIndexDrainer({
      db: deps.db,
      resolver: deps.resolver,
      logger: deps.logger,
      now: this.#clock,
    });
  }

  /** The claimant id this instance stamps, which is what makes its own claims recoverable. */
  get claimantId(): string {
    return this.#claimant.id;
  }

  get inFlight(): number {
    return this.#running.size;
  }

  /** True while the breaker holds claiming off. Retries and signals both wait it out. */
  get paused(): boolean {
    return this.#paused;
  }

  /** Jobs waiting on their backoff delay, whose claims this instance still holds. */
  get retrying(): number {
    return this.#retries.size;
  }

  /**
   * What intake calls when it enqueues. It carries no job: the claim loop reads the queue,
   * so a wakeup that arrives for a job another worker already took costs one empty claim
   * attempt and nothing else. Installs no timer, which is what keeps the enqueue path free
   * of any wait between the write and the run.
   *
   * Inert until `start()`: the dispatch seam this replaced subscribed inside `start()`, so a
   * pre-start enqueue never reached the claim loop. The row is durable in the queue and the
   * startup drain runs it; claiming it early would race the drain's reclaim ordering.
   */
  wake(): void {
    if (!this.#started) {
      return;
    }
    this.#pump();
  }

  /**
   * A reflection that arrives mid-drain is not lost: `wake` pumps the same claim loop the
   * drain is already running. The order of the drain itself is fixed: a dead process's claims
   * come back before anything is claimed, and pending vectors are attached before the pipeline
   * reads the nodes that need them.
   */
  async start(): Promise<ReflectionDrain> {
    if (this.#started) {
      this.#deps.logger.warn('reflection worker already started');
      return EMPTY_DRAIN;
    }
    this.#started = true;
    this.#stopped = false;
    this.#index.resume();
    const reclaimed = reclaimStaleReflectionJobs(this.#deps.db, this.#staleTimeoutMs);
    this.#startReaper();
    const vectored = await drainPendingVectors(this.#deps, this.#vectorBatchSize);
    const ran = await this.#drainQueue();
    // After the pipeline, not before it: an acceptance writes both rows, and indexing a source
    // whose projection this drain is about to rebuild would index the old parts.
    const indexed = await this.#index.settle();

    this.#deps.logger.info(
      { reclaimed, vectored, ran, indexed, claimantId: this.#claimant.id },
      'reflection worker drained and listening',
    );
    return { reclaimed, vectored, ran, indexed };
  }

  /**
   * Gives back what this instance holds so the next process does not wait out the stale
   * timeout for it: both kinds of timer, and every claim parked on a backoff. Runs already in
   * flight are awaited rather than abandoned, since they are the ones still writing to the
   * graph.
   */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#index.stop();
    if (this.#cooldown !== undefined) {
      clearTimeout(this.#cooldown);
      this.#cooldown = undefined;
    }
    if (this.#reaper !== undefined) {
      this.#reaper.stop();
      this.#reaper = undefined;
    }
    this.#paused = false;

    // Twice: a run still in flight can fail while the first pass is waiting on it, and the
    // claim it parks would otherwise outlive the worker holding it.
    this.#releaseHeld();
    await this.whenIdle();
    this.#releaseHeld();
    this.#started = false;
  }

  /**
   * Half the stale window, so an abandoned claim waits at most one and a half windows rather
   * than for the next restart. Unreferenced: a reaper that has nothing to reap must not be
   * the reason the process stays alive.
   */
  #startReaper(): void {
    this.#reaper = new SweepTimer(
      halfWindowIntervalMs(this.#staleTimeoutMs, REAPER_MIN_INTERVAL_MS),
      () => {
        this.#reapStaleClaims();
      },
    );
    this.#reaper.start();
  }

  #reapStaleClaims(): void {
    if (this.#stopped) {
      return;
    }
    let reclaimed: number;
    try {
      // A claim expiry is a lock stamp, so it is measured against the wall clock rather than
      // the run clock: a replay pinned to an old date must not read live claims as abandoned.
      reclaimed = reclaimStaleReflectionJobs(
        this.#deps.db,
        this.#staleTimeoutMs,
        new Date(),
        this.#claimant.id,
      );
    } catch (err) {
      this.#deps.logger.error({ err }, 'reflection worker could not sweep stale claims');
      return;
    }
    if (reclaimed === 0) {
      return;
    }
    this.#deps.logger.info({ reclaimed }, 'reflection worker reclaimed abandoned claims');
    this.#pump();
  }

  #releaseHeld(): void {
    for (const [jobId, held] of this.#retries) {
      clearTimeout(held.timer);
      this.#claimant.release(this.#deps.db, jobId, held.reason);
    }
    this.#retries.clear();
  }

  /** Resolves when nothing is running. Rows waiting on a backoff are not runs. */
  async whenIdle(): Promise<void> {
    while (this.#running.size > 0 || this.#index.inFlight().length > 0) {
      await Promise.allSettled([...this.#running, ...this.#index.inFlight()]);
    }
  }

  /**
   * Claims up to the pool's width and starts each job. Synchronous through every claim, so
   * two pumps in one turn of the event loop cannot hand the same row to two runs, and the
   * `UPDATE … RETURNING` behind it covers every other process.
   */
  #pump(): void {
    if (this.#stopped || this.#paused) {
      return;
    }
    while (this.#running.size < this.#workerCount) {
      let job: ReflectionJob | undefined;
      try {
        job = this.#claimant.claimNext(this.#deps.db, this.#maxAttempts, RUNNABLE_JOB_TYPES);
      } catch (err) {
        this.#deps.logger.error({ err }, 'reflection worker could not claim a job');
        return;
      }
      if (job === undefined) {
        // The queue ran dry, which is the moment the index rows can have the process.
        this.#index.pump();
        return;
      }
      this.#launch(job);
    }
  }

  /**
   * What lands in the pool is the settled wrapper, not the run: a rejection that escaped
   * `#execute` would otherwise leave its promise in the pool forever and wedge the loop.
   */
  #launch(job: ReflectionJob): void {
    const settled = this.#execute(job).catch((err: unknown) => {
      this.#deps.logger.error(
        { err, jobId: job.id },
        'reflection worker lost a job to an unhandled failure',
      );
    });
    this.#running.add(settled);
    void settled.then(() => {
      this.#running.delete(settled);
      this.#pump();
    });
  }

  /** Never rejects: every outcome is either the job's completion or its recorded failure. */
  async #execute(job: ReflectionJob): Promise<void> {
    this.#processed += 1;
    const episodeId = episodeIdOf(job);
    if (job.jobType !== INTEGRATE_JOB_TYPE || episodeId === undefined) {
      this.#fail(job, `unrunnable job of type ${job.jobType}`);
      return;
    }

    try {
      // The dequeue moment, passed rather than read inside the run, so every transaction stamp
      // and every elapsed-time decision in the pipeline shares one reading. World time is not
      // this: the orchestrator takes it from the episode, which is what lets a replay run a
      // years-old episode on today's clock without dating its writes to the conversation.
      const now = this.#clock();
      const run = await this.#deps.runner.run(episodeId, { now });
      // `applied` and not `status` decides: a completed run that enriched nothing left the
      // ledger open, which is the orchestrator saying the episode is still worth a retry.
      if (run.applied || run.status !== 'completed') {
        await this.#settle(job, episodeId, run);
        return;
      }
      this.#fail(job, describeFailedRun(episodeId, run));
    } catch (err) {
      this.#fail(job, errorMessage(err));
    }
  }

  /**
   * The run's settlement, published rather than committed here. The stage outcomes, the
   * semantic-processing acknowledgment and the queue row land in one acknowledgment, so a
   * reference accepted while the run worked moves the version, the check refuses, and the job
   * stays claimable instead of completing over an update nobody made.
   */
  async #settle(job: ReflectionJob, episodeId: string, run: ReflectionRun): Promise<void> {
    const outcome = await this.#deps.publications.publish({
      kind: 'reflection_completion',
      operationId: `reflection-completion:${job.id}:${String(job.attempts)}`,
      payload: { sourceId: episodeId, jobId: job.id, stages: completionStages(run.summary) },
    });
    if (outcome.status !== 'acknowledged') {
      this.#fail(job, `completion ${outcome.status}: ${outcome.reason}`);
      return;
    }
    this.#succeed(job, episodeId, run);
  }

  #succeed(job: ReflectionJob, episodeId: string, run: ReflectionRun): void {
    this.#consecutiveFailures = 0;
    this.#claimant.complete(this.#deps.db, job.id);
    // Only a run that actually enriched something is the freshness pin's "intake to
    // enriched": `already_applied` and `episode_unavailable` measured nothing new, and
    // recording them would understate the lag the p95 exists to catch.
    if (run.applied && run.status === 'completed') {
      recordEnrichmentLagMs(this.#deps.db, Date.now() - Date.parse(job.enqueuedAt));
    }
    // Debug, not info: the orchestrator's own 'reflection enriched' line lands a millisecond
    // earlier with the same episode, status and counts. The job id is all this adds.
    this.#deps.logger.debug(
      {
        jobId: job.id,
        episodeId,
        status: run.status,
        applied: run.applied,
        counts: run.summary.counts,
      },
      'reflection job complete',
    );
  }

  /**
   * The claim is held through the backoff rather than released into it: an unclaimed row is
   * claimable, so releasing first would let the next signal or the drain re-run the job
   * immediately and turn the delay into a spin. The release that counts the attempt and
   * records the reason happens when the delay is up, or when `stop()` gives the job back.
   *
   * A job that has spent its attempts is released now and stays in the queue with its last
   * error. Claiming skips it from then on: it is maintenance's, not the worker's.
   */
  #fail(job: ReflectionJob, reason: string): void {
    const attempts = job.attempts + 1;
    this.#noteFailure();

    if (attempts >= this.#maxAttempts) {
      this.#claimant.release(this.#deps.db, job.id, reason);
      this.#deps.logger.error(
        { jobId: job.id, attempts, reason },
        'reflection job exhausted its attempts; left queued for maintenance',
      );
      return;
    }

    const delayMs = backoffDelayMs(attempts, this.#retryBaseMs, this.#retryCapMs);
    const timer = setTimeout(() => {
      this.#retries.delete(job.id);
      this.#claimant.release(this.#deps.db, job.id, reason);
      this.#pump();
    }, delayMs);
    this.#retries.set(job.id, { timer, reason });
    this.#deps.logger.warn(
      { jobId: job.id, attempts, delayMs, reason },
      'reflection job failed; retry scheduled',
    );
  }

  /**
   * Five consecutive failures pause claiming for a cooldown. The pause is the whole of the
   * degradation: no lexical extractor stands in for the model, because late structure beats
   * bad structure and the queue is durable enough to wait.
   */
  #noteFailure(): void {
    this.#consecutiveFailures += 1;
    if (this.#consecutiveFailures < this.#breakerThreshold || this.#paused) {
      return;
    }
    this.#paused = true;
    this.#deps.logger.error(
      { failures: this.#consecutiveFailures, cooldownMs: this.#breakerCooldownMs },
      'reflection worker paused; claiming resumes after the cooldown',
    );
    this.#cooldown = setTimeout(() => {
      this.#cooldown = undefined;
      this.#paused = false;
      this.#consecutiveFailures = 0;
      this.#deps.logger.info('reflection worker resumed after cooldown');
      this.#pump();
    }, this.#breakerCooldownMs);
  }

  /** Runs every claimable row, including a legacy one no signal will ever arrive for. */
  async #drainQueue(): Promise<number> {
    const before = this.#processed;
    this.#pump();
    await this.whenIdle();
    return this.#processed - before;
  }
}
