import type { Driver } from 'neo4j-driver';

import { flushReinforcementQueue, type HebbianFlushReport } from './flush.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';

export type { HebbianFlushReport };

/**
 * Ordinary reinforcement draining, with one owner and a clock of its own.
 *
 * Two things were separate before and are one here. Cadence: the flush used to wait for the
 * maintenance tick to select it, which is a quarter-hour bucket the loop fills with whatever
 * scores highest, so a queue filling steadily waits out however many cycles the rest of the
 * catalog takes. And ownership: `claimReinforcementSignals` is a SELECT over the oldest bursts,
 * not an exclusive claim, so two drainers running at once read the same rows and apply the same
 * window twice. A timer beside the maintenance operation would have created exactly that, so the
 * operation delegates here instead of drawing its own batches.
 *
 * What this does not change is the flush itself. One call still claims whole bursts, folds them
 * to one step per pair, writes the graph before it deletes the rows, and leaves a crash between
 * the two to replay a bounded step. The at-least-once semantics and the bound that makes them
 * acceptable are `flush.ts`'s and stay there.
 */

/**
 * The paper's cadence, in milliseconds.
 *
 * Five seconds with the existing hundred-row batch machinery: the flush already drains toward a
 * per-run ceiling in batches, so the cadence is what decides how long a signal waits before the
 * first of those batches claims it, and nothing about the batch shape changes.
 */
export const DEFAULT_DRAIN_INTERVAL_MS = 5_000;

export type ReinforcementDrainReport = HebbianFlushReport & {
  /** Batches the loop actually called the flush for. */
  readonly batches: number;
  /** True when the ceiling stopped the loop with signals still queued, rather than an empty queue. */
  readonly ceilingHit: boolean;
  /** True when the shutdown signal stopped the loop before the queue emptied or the ceiling was hit. */
  readonly aborted: boolean;
  /** True when another caller held the queue and this one consumed nothing. */
  readonly deferred: boolean;
};

const NOTHING_DRAINED: ReinforcementDrainReport = {
  signalsClaimed: 0,
  pairsApplied: 0,
  edgesUpdated: 0,
  signalsDeleted: 0,
  batches: 0,
  ceilingHit: false,
  aborted: false,
  deferred: false,
};

/**
 * Drains batches until the queue reports empty, the run ceiling is reached, or the signal
 * aborts, whichever comes first. One call can carry the total past the ceiling by up to the size
 * of the last burst it claimed, the same rounding one batch already does, extended to the run.
 *
 * `drainOneBatch` is injected so the loop's own stopping conditions are testable against canned
 * reports, with no queue, database, or graph behind it.
 */
export async function drainReinforcementQueue(
  drainOneBatch: () => Promise<HebbianFlushReport>,
  ceiling: number,
  signal: AbortSignal,
): Promise<Omit<ReinforcementDrainReport, 'deferred'>> {
  let signalsClaimed = 0;
  let pairsApplied = 0;
  let edgesUpdated = 0;
  let signalsDeleted = 0;
  let batches = 0;

  while (signalsClaimed < ceiling && !signal.aborted) {
    const report = await drainOneBatch();
    batches += 1;
    signalsClaimed += report.signalsClaimed;
    pairsApplied += report.pairsApplied;
    edgesUpdated += report.edgesUpdated;
    signalsDeleted += report.signalsDeleted;
    if (report.signalsClaimed === 0) {
      break;
    }
  }

  return {
    signalsClaimed,
    pairsApplied,
    edgesUpdated,
    signalsDeleted,
    batches,
    ceilingHit: signalsClaimed >= ceiling,
    aborted: signal.aborted,
  };
}

export type ReinforcementDrainOptions = {
  readonly ceiling: number;
  /** The one batch call, injected so the owner is testable with no stores behind it. */
  readonly drainOneBatch: () => Promise<HebbianFlushReport>;
};

/**
 * The one consumer of the reinforcement queue.
 *
 * A second caller arriving while a drain is in flight does not start its own: it waits for the
 * one running and reports that it consumed nothing. The queue's own claim is a SELECT, so two
 * overlapping drains would read the same oldest bursts, apply the same window twice and then
 * both delete it; serializing here is what makes the read behave like a claim for every caller
 * that goes through this object.
 *
 * It serializes callers in this process. A second process pointed at the same substrate is
 * outside what an in-process owner can reach, which is why the service installs one of these and
 * every path that drains in that process delegates to it.
 */
export class ReinforcementDrain {
  readonly #options: ReinforcementDrainOptions;
  #inFlight: Promise<unknown> | undefined;

  constructor(options: ReinforcementDrainOptions) {
    this.#options = options;
  }

  /** True while a drain this object started has not finished. */
  get busy(): boolean {
    return this.#inFlight !== undefined;
  }

  async drainOnce(
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ReinforcementDrainReport> {
    const running = this.#inFlight;
    if (running !== undefined) {
      await running;
      return { ...NOTHING_DRAINED, deferred: true };
    }
    const started = drainReinforcementQueue(
      this.#options.drainOneBatch,
      this.#options.ceiling,
      signal,
    );
    this.#inFlight = started;
    try {
      return { ...(await started), deferred: false };
    } finally {
      this.#inFlight = undefined;
    }
  }
}

export type ReinforcementDrainDeps = {
  readonly driver: Driver;
  readonly db: SqliteHandle;
  readonly logger: Logger;
};

export type ReinforcementFlushSettings = {
  readonly batchSize: number;
  readonly learningRate: number;
  readonly weightFloor: number;
  readonly ceiling: number;
  /** The run clock, so a caller driving fixture time is not overridden by the wall clock. */
  readonly now?: () => Date;
};

/** The owner the service installs: the real flush, on the deployment's own numbers. */
export function reinforcementDrain(
  deps: ReinforcementDrainDeps,
  settings: ReinforcementFlushSettings,
): ReinforcementDrain {
  return new ReinforcementDrain({
    ceiling: settings.ceiling,
    drainOneBatch: () =>
      flushReinforcementQueue(deps, {
        batchSize: settings.batchSize,
        learningRate: settings.learningRate,
        weightFloor: settings.weightFloor,
        now: settings.now?.() ?? new Date(),
      }),
  });
}

export type ReinforcementCadenceOptions = {
  readonly intervalMs?: number;
  /** Where a drain that threw is reported. Absent leaves a failed drain to the next tick alone. */
  readonly logger?: Logger;
};

/**
 * The drain's own timer.
 *
 * One timer, rearmed from the end of each drain rather than a repeating interval, so a drain
 * that outruns its own period delays the next one instead of stacking on top of it. The timer is
 * unreferenced: a substrate with nothing to reinforce must not be the reason the process stays
 * alive. Stopping waits out the drain in flight, and a stopped cadence stays stopped, both the
 * way the introspection loop's own timer behaves.
 *
 * No bounded drain can promise zero drops under sustained overload. What the cadence changes is
 * how long a signal waits for the first batch that could claim it: the queue's rolling cap still
 * trims the oldest rows when arrival outruns service for long enough, and the dropped counter
 * still says so.
 */
export class ReinforcementCadence {
  readonly #drain: ReinforcementDrain;
  readonly #intervalMs: number;
  readonly #logger: Logger | undefined;
  readonly #abort = new AbortController();
  #timer: NodeJS.Timeout | undefined;
  #pending: Promise<void> = Promise.resolve();
  #stopped = false;

  constructor(drain: ReinforcementDrain, options: ReinforcementCadenceOptions = {}) {
    this.#drain = drain;
    this.#intervalMs = options.intervalMs ?? DEFAULTS.hebbian.drainIntervalMs;
    this.#logger = options.logger;
  }

  get intervalMs(): number {
    return this.#intervalMs;
  }

  get running(): boolean {
    return this.#timer !== undefined;
  }

  start(): void {
    if (this.#timer !== undefined || this.#stopped) {
      return;
    }
    this.#schedule();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#abort.abort();
    await this.#pending;
  }

  /** Resolves once the drain in progress, if any, has settled. */
  async whenIdle(): Promise<void> {
    await this.#pending;
  }

  #schedule(): void {
    this.#timer = setTimeout(() => {
      this.#pending = this.#pending.then(async () => {
        try {
          await this.#drain.drainOnce(this.#abort.signal);
        } catch (err) {
          // The cadence outlives every drain. A graph write that failed leaves its rows in
          // place, which is what the next drain is for.
          this.#logger?.error({ err }, 'reinforcement drain failed');
        }
        if (!this.#stopped) {
          this.#schedule();
        }
      });
    }, this.#intervalMs);
    this.#timer.unref();
  }
}
