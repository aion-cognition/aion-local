import type { Driver } from 'neo4j-driver';
import { ReflectionQueueClaimant, reclaimStaleReflectionJobs } from '../../infrastructure/sqlite/claim.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { recordEnrichmentLagMs } from '../../infrastructure/sqlite/lag-samples.js';
import type { ReflectionJob } from '../../infrastructure/sqlite/reflection-queue.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { Provider } from '../../infrastructure/providers/types.js';
import type { ReflectionDispatch } from './dispatch.js';
import { INTEGRATE_JOB_TYPE } from './intake.js';
import type { ReflectionRun, ReflectionRunOptions } from './orchestrator.js';
import { attachContentVectors, findPendingVectorNodes } from './vectors.js';

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
 * Pinned defaults for the reflection pipeline. The integration task threads config over the
 * ones config carries.
 */
export const DEFAULT_WORKER_COUNT = 1;
export const DEFAULT_DRAIN_STALE_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_RETRY_BASE_MS = 5_000;
export const DEFAULT_RETRY_CAP_MS = 5 * 60 * 1000;
export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_BREAKER_THRESHOLD = 5;
export const DEFAULT_BREAKER_COOLDOWN_MS = 60_000;
export const DEFAULT_VECTOR_BATCH_SIZE = 64;

/** `ReflectionOrchestrator` satisfies this; the worker never constructs the pipeline it drives. */
export type ReflectionRunner = {
  run(episodeId: string, options?: ReflectionRunOptions): Promise<ReflectionRun>;
};

export type ReflectionWorkerDeps = {
  readonly driver: Driver;
  readonly db: SqliteHandle;
  readonly provider: Provider;
  readonly dispatch: ReflectionDispatch;
  readonly runner: ReflectionRunner;
  readonly logger: Logger;
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
};

export type ReflectionDrain = {
  /** Claims a dead process left behind, returned to the pool. */
  readonly reclaimed: number;
  /** `:Memory` nodes an earlier inference outage left without a content vector. */
  readonly vectored: number;
  /** Jobs this drain ran, whatever each of them made of its episode. */
  readonly ran: number;
};

const EMPTY_DRAIN: ReflectionDrain = { reclaimed: 0, vectored: 0, ran: 0 };

type HeldRetry = {
  readonly timer: NodeJS.Timeout;
  readonly reason: string;
};

/** Doubling from `baseMs` on the failure just recorded, never past `capMs`. */
export function backoffDelayMs(attempts: number, baseMs: number, capMs: number): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(baseMs * 2 ** exponent, capMs);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

/** Intake writes `{ episode_id }` and nothing else enqueues an integrate job. */
function episodeIdOf(job: ReflectionJob): string | undefined {
  const payload = job.payload as { episode_id?: unknown } | null | undefined;
  const episodeId = payload?.episode_id;
  if (typeof episodeId === 'string' && episodeId !== '') {
    return episodeId;
  }
  return undefined;
}

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

  /** Runs in flight. Its size is the pool occupancy the claim loop reads. */
  readonly #running = new Set<Promise<void>>();
  /** Jobs whose claim this instance holds through a backoff delay, keyed by job id. */
  readonly #retries = new Map<string, HeldRetry>();
  #cooldown: NodeJS.Timeout | undefined;
  #reaper: NodeJS.Timeout | undefined;
  #consecutiveFailures = 0;
  #paused = false;
  #unsubscribe: (() => void) | undefined;
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
   * Subscribes first, then drains, so a reflection that arrives mid-drain is not lost: the
   * signal pumps the same claim loop the drain is already running. The order of the drain
   * itself is fixed: a dead process's claims come back before anything is claimed, and
   * pending vectors are attached before the pipeline reads the nodes that need them.
   */
  async start(): Promise<ReflectionDrain> {
    if (this.#started) {
      this.#deps.logger.warn('reflection worker already started');
      return EMPTY_DRAIN;
    }
    this.#started = true;
    this.#stopped = false;
    this.#unsubscribe = this.#deps.dispatch.subscribe(() => {
      this.#pump();
    });

    const reclaimed = reclaimStaleReflectionJobs(this.#deps.db, this.#staleTimeoutMs);
    this.#startReaper();
    const vectored = await this.#drainPendingVectors();
    const ran = await this.#drainQueue();

    this.#deps.logger.info(
      { reclaimed, vectored, ran, claimantId: this.#claimant.id },
      'reflection worker drained and listening',
    );
    return { reclaimed, vectored, ran };
  }

  /**
   * Gives back what this instance holds so the next process does not wait out the stale
   * timeout for it: the subscription, both kinds of timer, and every claim parked on a
   * backoff. Runs already in flight are awaited rather than abandoned, since they are the
   * ones still writing to the graph.
   */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#unsubscribe !== undefined) {
      this.#unsubscribe();
      this.#unsubscribe = undefined;
    }
    if (this.#cooldown !== undefined) {
      clearTimeout(this.#cooldown);
      this.#cooldown = undefined;
    }
    if (this.#reaper !== undefined) {
      clearInterval(this.#reaper);
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
    const everyMs = Math.max(1_000, Math.floor(this.#staleTimeoutMs / 2));
    this.#reaper = setInterval(() => {
      this.#reapStaleClaims();
    }, everyMs);
    this.#reaper.unref();
  }

  #reapStaleClaims(): void {
    if (this.#stopped) {
      return;
    }
    let reclaimed = 0;
    try {
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
    while (this.#running.size > 0) {
      await Promise.allSettled([...this.#running]);
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
        job = this.#claimant.claimNext(this.#deps.db, this.#maxAttempts);
      } catch (err) {
        this.#deps.logger.error({ err }, 'reflection worker could not claim a job');
        return;
      }
      if (job === undefined) {
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
      this.#deps.logger.error({ err, jobId: job.id }, 'reflection worker lost a job to an unhandled failure');
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
      const run = await this.#deps.runner.run(episodeId);
      // `applied` and not `status` decides: a completed run that enriched nothing left the
      // ledger open, which is the orchestrator saying the episode is still worth a retry.
      if (run.applied || run.status !== 'completed') {
        this.#succeed(job, episodeId, run);
        return;
      }
      this.#fail(job, `no stage enriched ${episodeId}`);
    } catch (err) {
      this.#fail(job, errorMessage(err));
    }
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
    this.#deps.logger.info(
      { jobId: job.id, episodeId, status: run.status, applied: run.applied, counts: run.summary.counts },
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
    this.#deps.logger.warn({ jobId: job.id, attempts, delayMs, reason }, 'reflection job failed; retry scheduled');
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

  /**
   * What an inference outage left behind, oldest first. A batch that comes back short of what
   * was asked for, or that writes fewer vectors than it read, is the end of the drain: the
   * rest is still pending and the next start or the `vector_backfill` operation takes it.
   */
  async #drainPendingVectors(): Promise<number> {
    let attached = 0;
    try {
      for (;;) {
        const batch = await findPendingVectorNodes(this.#deps.driver, this.#vectorBatchSize);
        if (batch.length === 0) {
          return attached;
        }
        const written = await attachContentVectors(this.#deps.driver, this.#deps.provider, batch);
        attached += written.length;
        if (written.length < batch.length || batch.length < this.#vectorBatchSize) {
          return attached;
        }
      }
    } catch (err) {
      this.#deps.logger.warn({ err, attached }, 'pending content vectors deferred; the drain continues');
      return attached;
    }
  }

  /** Runs every claimable row, including a legacy one no signal will ever arrive for. */
  async #drainQueue(): Promise<number> {
    const before = this.#processed;
    this.#pump();
    await this.whenIdle();
    return this.#processed - before;
  }
}
