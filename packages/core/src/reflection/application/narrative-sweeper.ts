import {
  sweepIdleSessions,
  type IdleSweepOptions,
  type NarrativeDeps,
  type NarrativeResult,
} from './narratives.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import {
  halfWindowIntervalMs,
  MIN_SWEEP_INTERVAL_MS as SHARED_MIN_SWEEP_INTERVAL_MS,
  SweepTimer,
} from '../../infrastructure/sweep-timer.js';

/**
 * The pinned narrative trigger has two halves: "MCP transport session end, or 30 min idle",
 * and this is the second one. `SessionNarrativeCloser` covers the client that says goodbye;
 * a client that vanishes without a DELETE never reaches it, and an editor that exits is
 * exactly that case. Without something on a clock, the idle rule is code nothing runs.
 *
 * The sweep is bounded per tick and best-effort: a failure is logged and the next tick tries
 * again. Nothing here decides whether a session is idle: `sweepIdleSessions` does, against
 * the same window the reflection stage uses.
 */

/** A floor, so a small configured window cannot turn the sweep into a spin. */
export const MIN_SWEEP_INTERVAL_MS = SHARED_MIN_SWEEP_INTERVAL_MS;

export type IdleNarrativeSweeperOptions = Omit<IdleSweepOptions, 'now'>;

/**
 * Half the idle window, so a session that went quiet is narrated within one and a half
 * windows of its last episode rather than whenever the process next restarts.
 */
export function sweepIntervalMs(idleMs: number): number {
  return halfWindowIntervalMs(idleMs);
}

export class IdleNarrativeSweeper {
  readonly #deps: NarrativeDeps;
  readonly #options: IdleNarrativeSweeperOptions;
  readonly #timer: SweepTimer;
  #pending: Promise<void> = Promise.resolve();
  #stopped = false;

  constructor(deps: NarrativeDeps, options: IdleNarrativeSweeperOptions = {}) {
    this.#deps = deps;
    this.#options = options;
    const idleMs = options.idleMs ?? DEFAULTS.reflection.narrativeIdleMinutes * 60 * 1000;
    this.#timer = new SweepTimer(sweepIntervalMs(idleMs), () => {
      this.#schedule();
    });
  }

  get intervalMs(): number {
    return this.#timer.intervalMs;
  }

  /**
   * The first tick is one interval out, since a service that just started has nothing idle
   * that the worker's own drain is not already about to reach.
   */
  start(): void {
    this.#stopped = false;
    this.#timer.start();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#timer.stop();
    await this.whenIdle();
  }

  /** Resolves once every sweep started so far has settled. */
  async whenIdle(): Promise<void> {
    await this.#pending;
  }

  /** One tick's work, chained so a slow sweep never overlaps the next tick's. */
  #schedule(): void {
    this.#pending = this.#pending.then(async () => {
      await this.sweepOnce();
    });
  }

  /** Exposed so a caller can drive one sweep without waiting out an interval. Never throws. */
  async sweepOnce(): Promise<readonly NarrativeResult[]> {
    if (this.#stopped) {
      return [];
    }
    try {
      const results = await sweepIdleSessions(this.#deps, this.#options);
      const created = results.filter((result) => result.status === 'created');
      if (created.length > 0) {
        this.#deps.logger.info(
          { created: created.length, considered: results.length },
          'idle sessions narrated',
        );
      }
      return results;
    } catch (err) {
      this.#deps.logger.error({ err }, 'idle narrative sweep failed');
      return [];
    }
  }
}
