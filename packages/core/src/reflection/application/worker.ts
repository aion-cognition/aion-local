import { randomUUID } from 'node:crypto';

import {
  completionBinding,
  completionStages,
  type CompletionBinding,
} from './completion-publication.js';
import { SourceIndexDrainer } from './index-drain.js';
import { VECTOR_JOB_TYPE } from './intake-queue.js';
import { INTEGRATE_JOB_TYPE } from './intake.js';
import type { ReflectionRun } from './orchestrator.js';
import { attachSourceVectors, drainPendingVectors } from './vectors.js';
import {
  EMPTY_DRAIN,
  type ReflectionDrain,
  type ReflectionWorkerDeps,
  type ReflectionWorkerOptions,
} from './worker-contract.js';
import { describeFailedRun, episodeIdOf } from './worker-diagnostics.js';
import { ClaimGate, RetryHolder } from './worker-retries.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { errorMessage } from '../../infrastructure/errors.js';
import { isGenerationUnavailable } from '../../infrastructure/providers/errors.js';
import {
  ReflectionQueueClaimant,
  reclaimStaleReflectionJobs,
} from '../../infrastructure/sqlite/claim.js';
import { recordEnrichmentLagMs } from '../../infrastructure/sqlite/lag-samples.js';
import { completeReflectionJobForSource } from '../../infrastructure/sqlite/reflection-queue.js';
import type { ReflectionJob } from '../../infrastructure/sqlite/reflection-queue.js';
import { halfWindowIntervalMs, SweepTimer } from '../../infrastructure/sweep-timer.js';
import { runGenerationUnavailability } from '../domain/stage.js';

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

export type {
  CompletionPublisher,
  ReflectionDrain,
  ReflectionRunner,
  ReflectionWorkerDeps,
  ReflectionWorkerOptions,
} from './worker-contract.js';

/**
 * A second, well under the minutes-scale floor the idle sweeps use. This one reaps another
 * process's abandoned claims, and a test drives it on the real clock.
 */
const REAPER_MIN_INTERVAL_MS = 1_000;

export { backoffDelayMs } from '../../infrastructure/backoff.js';
export { describeFailedRun } from './worker-diagnostics.js';

/** Claiming another kind of source work would spend its attempts failing it here. */
const RUNNABLE_JOB_TYPES: readonly string[] = [INTEGRATE_JOB_TYPE, VECTOR_JOB_TYPE];

/**
 * What is still runnable with no key: the embedding, which reaches the local model and has
 * nothing to do with generation. A keyless substrate keeps vectoring what it captures.
 */
const KEYLESS_JOB_TYPES: readonly string[] = [VECTOR_JOB_TYPE];

export class ReflectionWorker {
  readonly #deps: ReflectionWorkerDeps;
  readonly #claimant = new ReflectionQueueClaimant();
  readonly #workerCount: number;
  readonly #staleTimeoutMs: number;
  readonly #retryBaseMs: number;
  readonly #retryCapMs: number;
  readonly #maxAttempts: number;
  readonly #vectorBatchSize: number;
  readonly #clock: () => Date;

  /** Runs in flight. Its size is the pool occupancy the claim loop reads. */
  readonly #running = new Set<Promise<void>>();
  readonly #index: SourceIndexDrainer;
  readonly #retries: RetryHolder;
  readonly #gate: ClaimGate;
  #reaper: SweepTimer | undefined;
  #started = false;
  #stopped = false;
  #processed = 0;
  /** Nodes the queued vector rows have embedded, reported beside the startup drain's own. */
  #vectored = 0;

  constructor(deps: ReflectionWorkerDeps, options: ReflectionWorkerOptions = {}) {
    this.#deps = deps;
    this.#workerCount = options.workerCount ?? DEFAULT_WORKER_COUNT;
    this.#staleTimeoutMs = options.staleTimeoutMs ?? DEFAULT_DRAIN_STALE_TIMEOUT_MS;
    this.#retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this.#retryCapMs = options.retryCapMs ?? DEFAULT_RETRY_CAP_MS;
    this.#maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.#vectorBatchSize = options.vectorBatchSize ?? DEFAULT_VECTOR_BATCH_SIZE;
    this.#clock = options.clock ?? ((): Date => new Date());
    this.#index = new SourceIndexDrainer({
      db: deps.db,
      resolver: deps.resolver,
      logger: deps.logger,
      now: this.#clock,
    });
    this.#gate = new ClaimGate({
      logger: deps.logger,
      breakerThreshold: options.breakerThreshold ?? DEFAULT_BREAKER_THRESHOLD,
      cooldownMs: options.breakerCooldownMs ?? DEFAULT_BREAKER_COOLDOWN_MS,
      onOpen: () => {
        this.#pump();
      },
    });
    this.#retries = new RetryHolder({
      db: deps.db,
      claimant: this.#claimant,
      logger: deps.logger,
      retryBaseMs: this.#retryBaseMs,
      retryCapMs: this.#retryCapMs,
      maxAttempts: this.#maxAttempts,
      onReleased: () => {
        this.#pump();
      },
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
    return this.#gate.paused;
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
    const drained = await drainPendingVectors(this.#deps, this.#vectorBatchSize);
    const ran = await this.#drainQueue();
    // The backlog the drain found, plus whatever the queued vector rows embedded on the way
    // through: both are nodes this start gave a vector to.
    const vectored = drained + this.#vectored;
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
    this.#gate.clear();
    if (this.#reaper !== undefined) {
      this.#reaper.stop();
      this.#reaper = undefined;
    }

    // Twice: a run still in flight can fail while the first pass is waiting on it, and the
    // claim it parks would otherwise outlive the worker holding it.
    this.#retries.releaseAll();
    await this.whenIdle();
    this.#retries.releaseAll();
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
    // The idle cadence, whatever the sweep found. A released index row has nothing else that
    // would ask for it again, so the reaper is where it gets asked.
    this.#index.pump();
    if (reclaimed === 0) {
      return;
    }
    this.#deps.logger.info({ reclaimed }, 'reflection worker reclaimed abandoned claims');
    this.#pump();
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
    if (this.#stopped || this.#gate.paused) {
      return;
    }
    while (this.#running.size < this.#workerCount) {
      let job: ReflectionJob | undefined;
      const claimable = this.#gate.generationHeld ? KEYLESS_JOB_TYPES : RUNNABLE_JOB_TYPES;
      try {
        job = this.#claimant.claimNext(this.#deps.db, this.#maxAttempts, claimable);
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
    const episodeId = episodeIdOf(job);
    if (episodeId === undefined || !RUNNABLE_JOB_TYPES.includes(job.jobType)) {
      this.#processed += 1;
      this.#fail(job, `unrunnable job of type ${job.jobType}`);
      return;
    }
    if (job.jobType === VECTOR_JOB_TYPE) {
      await this.#vectorize(job, episodeId);
      return;
    }
    // Counted after the vector branch: `ran` is the enrichment count the lanes and the breaker
    // reason about, and an embedding is reported as vectors rather than as a run.
    this.#processed += 1;

    try {
      // The dequeue moment, passed rather than read inside the run, so every transaction stamp
      // and every elapsed-time decision in the pipeline shares one reading. The orchestrator
      // takes world time from the episode, which is what lets a replay run a years-old episode
      // on today's clock without dating its writes to the conversation.
      const now = this.#clock();
      // Read before the run, not after it. The completion is a statement about the obligations
      // the run started with, so a generation replaced while it worked and a row the source
      // began owing mid-run both have to read as a difference rather than as this run's input.
      const bound = completionBinding(this.#deps.db, episodeId);
      const run = await this.#deps.runner.run(episodeId, { now });
      // `applied` and not `status` decides whether the JOB is done: a completed run that enriched
      // nothing left the ledger open, which is the orchestrator saying the episode is still worth
      // a retry.
      const finished = run.applied || run.status !== 'completed';
      // Either way the run knows what it settled and what it left owed, and that has to be
      // durable before the job goes back: a remainder the worker dropped on its way to #fail is
      // a judgment nobody can ask about again. A progress publication closes no queue row and
      // discharges no effect; it records the typed outcomes and the work still owed.
      await this.#settle(job, episodeId, run, bound, finished);
      if (!finished) {
        // Which of the two the run owes: another attempt, or a wait. A run whose every failure
        // was the backend refusing to run at all learned nothing this episode could learn, and
        // charging it would exhaust the row a later key or a new day was meant to revive.
        const refused = runGenerationUnavailability(run.summary.stages);
        if (refused !== undefined) {
          this.#defer(job, refused.reason);
          return;
        }
        this.#fail(job, describeFailedRun(episodeId, run));
      }
    } catch (err) {
      if (isGenerationUnavailable(err)) {
        this.#defer(job, errorMessage(err));
        return;
      }
      this.#fail(job, errorMessage(err));
    }
  }

  /**
   * The embedding an acceptance queued. It completes its own row: a content vector is a property
   * on a node the acceptance already committed rather than an obligation anything else reads, so
   * there is no settlement to publish. The completion is bound to the source, the way the
   * pipeline's is, so a row whose id this holds but whose episode it does not cannot be the row
   * it finished.
   */
  async #vectorize(job: ReflectionJob, episodeId: string): Promise<void> {
    try {
      const attached = await attachSourceVectors(this.#deps, episodeId);
      completeReflectionJobForSource(this.#deps.db, job.id, episodeId);
      this.#vectored += attached;
      this.#gate.succeeded();
      this.#deps.logger.debug({ jobId: job.id, episodeId, attached }, 'content vectors attached');
    } catch (err) {
      this.#fail(job, errorMessage(err));
    }
  }

  /** Work that cannot run at all rather than work that failed. The gate narrows claiming. */
  #defer(job: ReflectionJob, reason: string): void {
    this.#retries.defer(job, reason);
    this.#gate.holdGeneration();
  }

  /**
   * The run's settlement, published rather than committed here. The stage outcomes, the
   * semantic-processing acknowledgment and the queue row land in one acknowledgment, so a
   * reference accepted while the run worked moves the version, the check refuses, and the job
   * stays claimable instead of completing over an update nobody made.
   *
   * A run that could not finish publishes the same way under the progress disposition: the same
   * typed outcomes and the same remainder, without the queue row and without the effect. A job
   * that is going back for a retry must not leave its progress in the process that had it.
   */
  async #settle(
    job: ReflectionJob,
    episodeId: string,
    run: ReflectionRun,
    bound: CompletionBinding,
    finished: boolean,
  ): Promise<void> {
    const disposition = finished ? 'settled' : 'progress';
    const outcome = await this.#deps.publications.publish({
      kind: 'reflection_completion',
      // Deferrals and requeues reuse failure counts; each run can report different progress.
      operationId: `reflection-completion:${job.id}:${randomUUID()}:${disposition}`,
      payload: {
        sourceId: episodeId,
        jobId: finished ? job.id : '',
        disposition,
        stages: completionStages(run.summary),
        ...bound,
      },
    });
    if (!finished) {
      return;
    }
    if (outcome.status !== 'acknowledged') {
      this.#fail(job, `completion ${outcome.status}: ${outcome.reason}`);
      return;
    }
    this.#succeed(job, episodeId, run);
  }

  /**
   * What is left after the acknowledgment landed. The queue row is not here: the completion
   * deletes it inside the same transaction as the settlement, so a process that dies between
   * the commit and this line leaves nothing half done for the next recovery to guess at.
   */
  #succeed(job: ReflectionJob, episodeId: string, run: ReflectionRun): void {
    this.#gate.succeeded();
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

  /** A failed job: counted against the breaker, then parked on its own backoff. */
  #fail(job: ReflectionJob, reason: string): void {
    this.#gate.failed();
    this.#retries.schedule(job, reason);
  }

  /** Runs every claimable row, including a legacy one no signal will ever arrive for. */
  async #drainQueue(): Promise<number> {
    const before = this.#processed;
    this.#pump();
    await this.whenIdle();
    return this.#processed - before;
  }
}
