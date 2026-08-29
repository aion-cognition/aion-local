import type { AionMcpService } from './service.js';

/**
 * The missing-DELETE backstop on a clock. `AionMcpService.closeIdleSessions` decides which sessions
 * qualify; this only keeps a tick reaching it, the same split `IdleNarrativeSweeper` (core)
 * uses for the idle narrative rule. Sweeping at half the idle window bounds how stale a
 * session can get past its deadline before something notices; the floor keeps a small
 * configured window from turning the sweep into a spin.
 */

export const MIN_SESSION_IDLE_SWEEP_INTERVAL_MS = 60_000;
const SWEEP_DIVISOR = 2;

export function sessionIdleSweepIntervalMs(idleMs: number): number {
  return Math.max(MIN_SESSION_IDLE_SWEEP_INTERVAL_MS, Math.floor(idleMs / SWEEP_DIVISOR));
}

export type SessionIdleSweeperOptions = {
  readonly idleMs: number;
};

export class SessionIdleSweeper {
  readonly #service: AionMcpService;
  readonly #idleMs: number;
  readonly #intervalMs: number;
  #timer: NodeJS.Timeout | undefined;

  constructor(service: AionMcpService, options: SessionIdleSweeperOptions) {
    this.#service = service;
    this.#idleMs = options.idleMs;
    this.#intervalMs = sessionIdleSweepIntervalMs(options.idleMs);
  }

  get intervalMs(): number {
    return this.#intervalMs;
  }

  /** Unreferenced: a sweep with nothing idle must not be the reason the process stays alive. */
  start(): void {
    if (this.#timer !== undefined) {
      return;
    }
    this.#timer = setInterval(() => {
      this.sweepOnce();
    }, this.#intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  /**
   * One tick's work, exposed so a test can drive it directly instead of a real interval.
   * `now` is a test seam for the same reason `closeIdleSessions` takes one.
   */
  sweepOnce(now?: Date): readonly string[] {
    return this.#service.closeIdleSessions(this.#idleMs, now?.getTime());
  }
}
