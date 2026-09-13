import { backoffDelayMs } from '../../infrastructure/backoff.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { ReflectionQueueClaimant } from '../../infrastructure/sqlite/claim.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import type { ReflectionJob } from '../../infrastructure/sqlite/reflection-queue.js';

/**
 * When the reflection worker waits, and for what: the claims it is holding through a backoff,
 * and the two gates that decide whether it may claim at all.
 *
 * A claim is held through its delay rather than released into it: an unclaimed row is claimable,
 * so releasing first would let the next signal or the drain re-run the job immediately and turn
 * the delay into a spin. The release that counts the attempt and records the reason happens when
 * the delay is up, or when the worker stops and gives the job back.
 */

type HeldRetry = {
  readonly timer: NodeJS.Timeout;
  readonly reason: string;
};

export type RetryHolderDeps = {
  readonly db: SqliteHandle;
  readonly claimant: ReflectionQueueClaimant;
  readonly logger: Logger;
  readonly retryBaseMs: number;
  readonly retryCapMs: number;
  readonly maxAttempts: number;
  /** Called when a parked claim goes back, so the loop can claim it again. */
  readonly onReleased: () => void;
};

export class RetryHolder {
  readonly #deps: RetryHolderDeps;
  readonly #held = new Map<string, HeldRetry>();

  constructor(deps: RetryHolderDeps) {
    this.#deps = deps;
  }

  /** Jobs waiting on their backoff delay, whose claims this instance still holds. */
  get size(): number {
    return this.#held.size;
  }

  /**
   * A failed job, parked on its backoff.
   *
   * A job that has spent its attempts is released now and stays in the queue with its last
   * error. Claiming skips it from then on: it is maintenance's, not the worker's.
   */
  schedule(job: ReflectionJob, reason: string): void {
    const attempts = job.attempts + 1;
    if (attempts >= this.#deps.maxAttempts) {
      this.#deps.claimant.release(this.#deps.db, job.id, reason);
      this.#deps.logger.error(
        { jobId: job.id, attempts, reason },
        'reflection job exhausted its attempts; left queued for maintenance',
      );
      return;
    }

    const delayMs = backoffDelayMs(attempts, this.#deps.retryBaseMs, this.#deps.retryCapMs);
    const timer = setTimeout(() => {
      this.#held.delete(job.id);
      this.#deps.claimant.release(this.#deps.db, job.id, reason);
      this.#deps.onReleased();
    }, delayMs);
    this.#held.set(job.id, { timer, reason });
    this.#deps.logger.warn(
      { jobId: job.id, attempts, delayMs, reason },
      'reflection job failed; retry scheduled',
    );
  }

  /**
   * A job put back without spending an attempt, for work that cannot run at all rather than
   * work that failed. Generation with no key is the case: the episode is fine, the pipeline is
   * fine, and burning three attempts against a missing key would leave the queue holding
   * exhausted rows that a later key would never revive.
   */
  defer(job: ReflectionJob, reason: string): void {
    this.#deps.claimant.release(this.#deps.db, job.id, reason, { countAttempt: false });
    this.#deps.logger.warn(
      { jobId: job.id, reason },
      'reflection job deferred; enrichment claiming narrows',
    );
  }

  /** Gives every parked claim back, so the next process does not wait out the stale timeout. */
  releaseAll(): void {
    for (const [jobId, held] of this.#held) {
      clearTimeout(held.timer);
      this.#deps.claimant.release(this.#deps.db, jobId, held.reason);
    }
    this.#held.clear();
  }
}

export type ClaimGateDeps = {
  readonly logger: Logger;
  readonly breakerThreshold: number;
  readonly cooldownMs: number;
  /** Called when a gate lifts, so the loop claims again. */
  readonly onOpen: () => void;
};

/**
 * When the worker may claim, and what it may claim.
 *
 * Two gates, and they are not the same thing. A run of consecutive failures closes claiming
 * outright for a cooldown, because something is wrong and spinning through the queue makes it
 * worse. Generation with no key closes only the enrichment half: those jobs are all about to
 * refuse for the same reason, and the embedding rows behind them reach a local model and have no
 * reason to wait. Closing both was the first shape of this and it stopped a keyless substrate
 * vectoring anything it captured.
 */
export class ClaimGate {
  readonly #deps: ClaimGateDeps;
  #cooldown: NodeJS.Timeout | undefined;
  #generationDeferred: NodeJS.Timeout | undefined;
  #consecutiveFailures = 0;

  constructor(deps: ClaimGateDeps) {
    this.#deps = deps;
  }

  /** True while the breaker holds claiming off. Retries and signals both wait it out. */
  get paused(): boolean {
    return this.#cooldown !== undefined;
  }

  /** True while generation has nowhere to run, which narrows claiming rather than stopping it. */
  get generationHeld(): boolean {
    return this.#generationDeferred !== undefined;
  }

  /** A run that finished. Resets the consecutive count the breaker is counting. */
  succeeded(): void {
    this.#consecutiveFailures = 0;
  }

  /** A failure. The breaker trips at the threshold and holds claiming for one cooldown. */
  failed(): void {
    this.#consecutiveFailures += 1;
    if (this.#consecutiveFailures < this.#deps.breakerThreshold || this.paused) {
      return;
    }
    this.#deps.logger.error(
      { failures: this.#consecutiveFailures, cooldownMs: this.#deps.cooldownMs },
      'reflection worker paused; claiming resumes after the cooldown',
    );
    this.#cooldown = setTimeout(() => {
      this.#cooldown = undefined;
      this.#consecutiveFailures = 0;
      this.#deps.logger.info('reflection worker resumed after cooldown');
      this.#deps.onOpen();
    }, this.#deps.cooldownMs);
  }

  /** Generation refused for want of a key. Enrichment waits; everything else carries on. */
  holdGeneration(): void {
    if (this.#generationDeferred !== undefined) {
      return;
    }
    this.#generationDeferred = setTimeout(() => {
      this.#generationDeferred = undefined;
      this.#deps.onOpen();
    }, this.#deps.cooldownMs);
  }

  /** Opens both gates and drops their timers, so a stopped worker holds nothing open. */
  clear(): void {
    for (const timer of [this.#cooldown, this.#generationDeferred]) {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
    this.#cooldown = undefined;
    this.#generationDeferred = undefined;
    this.#consecutiveFailures = 0;
  }
}
