/**
 * The timer shell three periodic sweeps had each written out for themselves: the idle
 * narrative sweep, the MCP session idle sweep, and the reflection worker's stale-claim reaper.
 * All three tick at half the window they guard, floor that so a small configured window cannot
 * turn a sweep into a spin, and unreference the timer so a sweep with nothing to do is never
 * the reason the process stays alive.
 *
 * The introspection loop deliberately does not use this. It rearms from the end of each tick
 * rather than repeating on a fixed interval, so a tick that outruns its own period delays the
 * next one instead of stacking on top of it, and it carries jitter and backoff this has no
 * notion of.
 */

/** Twice per window, so what went quiet is noticed within one and a half windows. */
export const SWEEP_DIVISOR = 2;

/** The floor every sweep of a minutes-scale window uses. */
export const MIN_SWEEP_INTERVAL_MS = 60_000;

export function halfWindowIntervalMs(
  windowMs: number,
  floorMs: number = MIN_SWEEP_INTERVAL_MS,
): number {
  return Math.max(floorMs, Math.floor(windowMs / SWEEP_DIVISOR));
}

/**
 * A repeating unreferenced timer. The tick is the caller's: this owns when it fires and
 * nothing about what it does, so a sweep that must not overlap itself or must swallow its own
 * failures still handles that where the work is.
 */
export class SweepTimer {
  readonly #intervalMs: number;
  readonly #tick: () => void;
  #timer: NodeJS.Timeout | undefined;

  constructor(intervalMs: number, tick: () => void) {
    this.#intervalMs = intervalMs;
    this.#tick = tick;
  }

  get intervalMs(): number {
    return this.#intervalMs;
  }

  /** Idempotent, and the first tick is one interval out rather than immediate. */
  start(): void {
    if (this.#timer !== undefined) {
      return;
    }
    this.#timer = setInterval(this.#tick, this.#intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }
}
