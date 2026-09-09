import type { EvidenceResolver } from '../../evidence/application/resolver.js';
import { backoffDelayMs } from '../../infrastructure/backoff.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { drainSourceIndexQueue } from '../../introspection/application/source-index-queue.js';

/**
 * The source-index rows, drained by whatever is already running.
 *
 * Intake writes two rows per acceptance and the reflection worker's claim filter deliberately
 * excludes the indexing one: claiming it there would spend the job's attempts failing it in a
 * pipeline that cannot run it. So something else has to claim it, and until something does, the
 * rows accumulate and every source behind them stays eviction-pinned forever. This is that
 * something, held by the worker and run at the moment its queue runs dry.
 *
 * Three things make it a scheduler rather than a call. A wakeup that arrives while a drain is
 * running is REMEMBERED, because that drain has already claimed its rows and will never see the
 * one that just landed. Each pass claims a bounded page rather than the whole pending population.
 * And a pass that left work deferred asks again on a backoff, because a released row with nothing
 * scheduled behind it waits for the next restart.
 */
export type SourceIndexDrainDeps = {
  readonly db: SqliteHandle;
  readonly resolver: EvidenceResolver;
  readonly logger: Pick<Logger, 'warn' | 'debug'>;
  readonly now: () => Date;
};

export type SourceIndexDrainOptions = {
  /** Rows one pass may claim. The pending population is not the unit of work. */
  readonly maxJobs?: number;
  readonly retryBaseMs?: number;
  readonly retryCapMs?: number;
};

/** One acceptance writes one row, so a page is a batch of acceptances rather than a backlog. */
const DEFAULT_MAX_JOBS = 32;
const DEFAULT_RETRY_BASE_MS = 30_000;
const DEFAULT_RETRY_CAP_MS = 15 * 60_000;

export class SourceIndexDrainer {
  readonly #deps: SourceIndexDrainDeps;
  readonly #inFlight = new Set<Promise<void>>();
  readonly #maxJobs: number;
  readonly #retryBaseMs: number;
  readonly #retryCapMs: number;
  #running = false;
  #stopped = false;
  /** A wakeup that arrived while a pass held its claims. The next pass owes it a run. */
  #pending = false;
  #deferrals = 0;
  #retry: NodeJS.Timeout | undefined;
  /** Documents drained since the last settle, so a caller reports work a pumped drain did. */
  #documents = 0;

  constructor(deps: SourceIndexDrainDeps, options: SourceIndexDrainOptions = {}) {
    this.#deps = deps;
    this.#maxJobs = options.maxJobs ?? DEFAULT_MAX_JOBS;
    this.#retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this.#retryCapMs = options.retryCapMs ?? DEFAULT_RETRY_CAP_MS;
  }

  /**
   * Runs one bounded pass and answers with the documents it wrote.
   *
   * Never concurrent with itself: the drain claims every row it will run before running any of
   * them, so a second pass entering while the first holds those claims would find nothing and
   * still cost a lease round trip. That is also why a concurrent request is remembered instead of
   * dropped. A failure is logged and swallowed, because the obligation is the queue row: indexing
   * that could not run is still owed, and letting it take the worker down would stop the pipeline
   * over work that has no freshness pin.
   */
  async run(): Promise<number> {
    if (this.#stopped) {
      return 0;
    }
    if (this.#running) {
      this.#pending = true;
      return 0;
    }
    this.#running = true;
    try {
      const drain = await drainSourceIndexQueue(this.#deps, { maxJobs: this.#maxJobs });
      this.#documents += drain.documents;
      // A page that filled its bound has more behind it, and a deferral is work still owed.
      if (drain.claimed >= this.#maxJobs) {
        this.#pending = true;
      }
      this.#deferrals = drain.deferred > 0 ? this.#deferrals + 1 : 0;
      if (drain.deferred > 0) {
        this.#scheduleRetry();
      }
      return drain.documents;
    } catch (err) {
      this.#deps.logger.warn({ err }, 'source index drain failed; the rows stay owed');
      this.#deferrals += 1;
      this.#scheduleRetry();
      return 0;
    } finally {
      this.#running = false;
    }
  }

  /**
   * Starts a drain without waiting for it, and tracks it so an idle check waits. Tracked apart
   * from the run pool it belongs beside: an index drain is not a job the worker count budgets,
   * and counting it there would narrow the pool every time the queue emptied.
   *
   * A request that arrives mid-pass is not dropped. The running pass claimed its rows before the
   * new one existed, so the wakeup is held and spent the moment that pass returns.
   */
  pump(): void {
    if (this.#stopped) {
      return;
    }
    if (this.#running) {
      this.#pending = true;
      return;
    }
    this.#start();
  }

  #start(): void {
    const settled = this.#cycle();
    this.#inFlight.add(settled);
    void settled.finally(() => {
      this.#inFlight.delete(settled);
    });
  }

  /** One pass, and every pass a wakeup arriving during it earned. */
  async #cycle(): Promise<void> {
    await this.run();
    while (this.#pending && !this.#stopped) {
      this.#pending = false;
      await this.run();
    }
  }

  /**
   * Everything drained since the last call, including what a drain the claim loop started did.
   *
   * A startup pass drains the pipeline first, and the moment that queue runs dry the loop pumps
   * an index drain of its own. Reporting only what the caller's own `run` found would credit
   * that work to nobody and read as a startup that indexed nothing.
   */
  async settle(): Promise<number> {
    await Promise.allSettled(this.inFlight());
    await this.#cycle();
    const total = this.#documents;
    this.#documents = 0;
    return total;
  }

  /** The drains still running, for a caller waiting on everything the worker has in flight. */
  inFlight(): readonly Promise<void>[] {
    return [...this.#inFlight];
  }

  /**
   * A pass that released a row asks again after a bounded wait. Without it the row waits for the
   * next acceptance or the next restart, which is not a schedule.
   */
  #scheduleRetry(): void {
    if (this.#stopped || this.#retry !== undefined) {
      return;
    }
    const delay = backoffDelayMs(this.#deferrals, this.#retryBaseMs, this.#retryCapMs);
    this.#retry = setTimeout(() => {
      this.#retry = undefined;
      this.pump();
    }, delay);
    this.#retry.unref();
  }

  stop(): void {
    this.#stopped = true;
    this.#pending = false;
    if (this.#retry !== undefined) {
      clearTimeout(this.#retry);
      this.#retry = undefined;
    }
  }

  resume(): void {
    this.#stopped = false;
    this.#deferrals = 0;
  }
}
