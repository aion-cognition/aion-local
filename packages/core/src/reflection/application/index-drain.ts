import type { EvidenceResolver } from '../../evidence/application/resolver.js';
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
 * It is a drain and not a loop with a timer. Indexing has no freshness pin, the obligation is the
 * durable queue row, and a source whose index is incomplete is already held against removal.
 */
export type SourceIndexDrainDeps = {
  readonly db: SqliteHandle;
  readonly resolver: EvidenceResolver;
  readonly logger: Pick<Logger, 'warn' | 'debug'>;
  readonly now: () => Date;
};

export class SourceIndexDrainer {
  readonly #deps: SourceIndexDrainDeps;
  readonly #inFlight = new Set<Promise<void>>();
  #running = false;
  #stopped = false;
  /** Documents drained since the last settle, so a caller reports work a pumped drain did. */
  #documents = 0;

  constructor(deps: SourceIndexDrainDeps) {
    this.#deps = deps;
  }

  /**
   * Runs the rows once and answers with the documents it wrote.
   *
   * Never concurrent with itself: the drain claims every row it will run before running any of
   * them, so a second pass entering while the first holds those claims would find nothing and
   * still cost a lease round trip. A failure is logged and swallowed, because the obligation is
   * the queue row. Indexing that could not run is still owed, and letting it take the worker
   * down would stop the pipeline over work that has no freshness pin.
   */
  async run(): Promise<number> {
    if (this.#stopped || this.#running) {
      return 0;
    }
    this.#running = true;
    try {
      const drain = await drainSourceIndexQueue(this.#deps);
      this.#documents += drain.documents;
      return drain.documents;
    } catch (err) {
      this.#deps.logger.warn({ err }, 'source index drain failed; the rows stay owed');
      return 0;
    } finally {
      this.#running = false;
    }
  }

  /**
   * Starts a drain without waiting for it, and tracks it so an idle check waits. Tracked apart
   * from the run pool it belongs beside: an index drain is not a job the worker count budgets,
   * and counting it there would narrow the pool every time the queue emptied.
   */
  pump(): void {
    if (this.#stopped || this.#running) {
      return;
    }
    const settled = this.run().then(() => undefined);
    this.#inFlight.add(settled);
    void settled.finally(() => {
      this.#inFlight.delete(settled);
    });
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
    await this.run();
    const total = this.#documents;
    this.#documents = 0;
    return total;
  }

  /** The drains still running, for a caller waiting on everything the worker has in flight. */
  inFlight(): readonly Promise<void>[] {
    return [...this.#inFlight];
  }

  stop(): void {
    this.#stopped = true;
  }

  resume(): void {
    this.#stopped = false;
  }
}
